import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { setupWebSocketHandler } from '../src/ws/handler.js'
import { SessionManagerRegistry } from '../src/agents/session-manager-registry.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Contract: a connection whose peer's JS has stopped running loses its event
 * listener; a connection whose peer is still there keeps it — no matter what
 * any OTHER connection does.
 *
 * Root cause: the admin client's zombie detection (2 unanswered `__ping__`
 * round-trips → close + reconnect) abandons a socket whose TCP is still
 * healthy. No close frame reaches the server, `ws.on('close')` never fires, and
 * the ConnectedClient keeps its listener registered — so every event is also
 * serialized into a socket nobody reads (unbounded send-buffer growth) and the
 * reconnect adds another listener beside the dead one. Live forensics: 4
 * listeners on one session, 3 admin sockets all readyState=OPEN.
 *
 * Why liveness is measured as "inbound application traffic" and not socket
 * state: an abandoned-but-ESTAB socket is byte-for-byte indistinguishable from
 * a healthy viewer by readyState/destroyed (measured on production sockets), and
 * the server's own protocol ping only proves the peer's KERNEL is answering.
 * Only a running JS client sends `__ping__`.
 *
 * The half-dead socket can't be simulated with `close()` (that fires the
 * server's close handler and cleans up properly). `pause()` + dropping the
 * client handle reproduces it: the server side stays OPEN, as in production.
 */

let workspace: string
let http: Server
let wss: WebSocketServer
let registry: SessionManagerRegistry
let port: number
/** Every socket this test opened — torn down in afterEach so a failing
 *  assertion can't leave an abandoned socket holding the process open. */
let sockets: WebSocket[] = []

const SID = 'sess-reclaim'

/** Listener count for a root session, read out of the real store. */
function listenerCount(sessionId: string): number {
  const sm = registry.getOrCreate(workspace)
  // eventListeners is private; this test asserts on it deliberately — it IS
  // the leaked resource, and the probe scripts used on production read the
  // same map.
  const listeners = (sm as unknown as {
    uiStore: { eventListeners: Map<string, Set<unknown>> }
  }).uiStore.eventListeners
  return listeners.get(sessionId)?.size ?? 0
}

function seedSession(id: string): void {
  registry.getOrCreate(workspace).getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    sockets.push(ws)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Send `subscribe` and wait until the server has processed it (its
 *  state:snapshot for this session id comes back). */
function subscribe(ws: WebSocket, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString('utf-8')) as { type?: string; snapshot?: { sessionId?: string } }
      if (msg.type === 'state:snapshot' && msg.snapshot?.sessionId === sessionId) {
        ws.off('message', onMsg)
        resolve()
      }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ type: 'subscribe', sessionId, projectId: workspace }))
  })
}

/** One client liveness probe, exactly as ws-client.ts sends it. */
function clientPing(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: '__ping__' }))
}

/**
 * Abandon a socket the way the browser's zombie path does: the page's JS gives
 * up on it (stops sending `__ping__`, stops dispatching inbound frames) while
 * the browser's network stack keeps answering protocol pings. No close frame is
 * sent, so the server's side stays OPEN and its `close` handler never runs —
 * the precondition for the leak.
 *
 * Do NOT `pause()` the socket here: pausing also suppresses ws's automatic pong
 * reply, so the server's pre-existing `missedPongs >= 2 → terminate()` would
 * clean the connection up and the test would pass without the reclaim ever
 * running (verified: with `pause()`, breaking the reclaim still passed). The
 * live process shows pongs continuing at exactly the 6-byte/frame floor, which
 * is precisely why the protocol keepalive can't see these sockets.
 */
function abandon(ws: WebSocket): void {
  ws.removeAllListeners('message')
}

/**
 * Advance time so the reclaim's 3min wall-clock threshold and the connection's
 * 10s keepalive tick both fire, without the test waiting for either. The
 * server's `lastClientPingAt` stamps and its `Date.now()` comparison live behind
 * a closure, so the clock is the only honest lever — and using it means the
 * real production code path does the work, not a copy of its logic.
 *
 * The fake clock is installed in `beforeEach` (before the server creates its
 * keepalive interval, or that interval would keep running on the real timer and
 * never be advanceable), with `shouldAdvanceTime` so socket I/O still progresses
 * on the real event loop in between.
 */
async function advanceServerClock(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  // Let the released-listener bookkeeping settle.
  await vi.advanceTimersByTimeAsync(50)
}

beforeEach(async () => {
  // Installed BEFORE setupWebSocketHandler so the per-connection keepalive
  // interval is created on the fake clock and `advanceServerClock` can drive it.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: Date.now() })
  sockets = []
  workspace = mkdtempSync(join(tmpdir(), 'halo-ws-reclaim-'))
  registry = new SessionManagerRegistry()
  // Seed the session row directly (createSession would build a live model runtime).
  seedSession(SID)

  http = createServer()
  wss = new WebSocketServer({ server: http, path: '/ws' })
  setupWebSocketHandler({ wss, registry })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
})

afterEach(async () => {
  for (const ws of sockets) ws.terminate()
  wss.close()
  await new Promise<void>((resolve) => { http.close(() => resolve()) })
  vi.useRealTimers()
  rmSync(workspace, { recursive: true, force: true })
})

describe('two live connections on ONE session', () => {
  it('do not evict each other (localStorage makes a second tab resolve to the same session)', async () => {
    // The admin keys its current session in localStorage, which is shared
    // per-origin — opening the same workspace in a second tab naturally
    // subscribes to the SAME session id. A previous fix evicted the peer on
    // every subscribe, which made the two tabs' reconnects evict each other at
    // ~1Hz forever. Both listeners must simply coexist.
    const tabA = await connect()
    await subscribe(tabA, SID)
    const tabB = await connect()
    await subscribe(tabB, SID)

    expect(listenerCount(SID)).toBe(2)

    // Still both there after more subscribes (a project switch re-subscribes).
    await subscribe(tabA, SID)
    await subscribe(tabB, SID)
    expect(listenerCount(SID)).toBe(2)

    // And both sockets are still usable — neither was closed under the other.
    expect(tabA.readyState).toBe(WebSocket.OPEN)
    expect(tabB.readyState).toBe(WebSocket.OPEN)
  })

  it('a late subscribe from a dying connection cannot take down the live viewer', async () => {
    // ws@8's closeTimeout is 30s and inbound messages are still dispatched
    // while a socket sits in CLOSING, so a socket the browser already gave up
    // on can still deliver a `subscribe`. It must not affect anyone else.
    const live = await connect()
    await subscribe(live, SID)
    const dying = await connect()
    await subscribe(dying, SID)
    expect(listenerCount(SID)).toBe(2)

    // `dying` starts closing, then gets one more subscribe in.
    dying.close()
    try { dying.send(JSON.stringify({ type: 'subscribe', sessionId: SID, projectId: workspace })) } catch { /* may already be gone */ }
    await vi.advanceTimersByTimeAsync(100)

    // The live viewer keeps its listener and its socket.
    expect(live.readyState).toBe(WebSocket.OPEN)
    let streamed = 0
    live.on('message', (raw: Buffer) => {
      if ((JSON.parse(raw.toString('utf-8')) as { type?: string }).type === 'chat:stream') streamed++
    })
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { uiStore: { emitEvent: (s: string, e: unknown) => void } })
      .uiStore.emitEvent(SID, { type: 'stream', text: 'still here', agentName: 'default' })
    await vi.advanceTimersByTimeAsync(150)
    expect(streamed).toBe(1)
  })
})

describe('reclaiming abandoned connections', () => {
  it('releases the listener of a connection that has gone silent past the threshold', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    // The browser gives up but TCP stays alive — no close frame, so the
    // server's close handler never runs and the listener would leak forever.
    abandon(ws)
    expect(listenerCount(SID)).toBe(1)

    // Age it past the 3min silence limit; the keepalive tick does the reclaim.
    await advanceServerClock(4 * 60_000)

    expect(listenerCount(SID)).toBe(0)
  }, 20_000)

  it('reclaims a CLOSED connection that still holds a listener, with no threshold wait', async () => {
    // Seen on the live process: sockets with destroyed=true still registered.
    // CLOSED + a listener is unambiguous, so it must not wait out 3min.
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    // Kill the socket without letting the server's close handler clean up.
    const serverSock = [...(wss.clients as Set<WebSocket>)][0]!
    // @ts-expect-error — drop the underlying transport, leaving readyState CLOSED.
    serverSock._socket.destroy()
    serverSock.removeAllListeners('close')
    await vi.advanceTimersByTimeAsync(50)

    // Only one keepalive tick — well inside the 3min limit, so the silence
    // threshold cannot be what reclaims this one.
    await advanceServerClock(11_000)

    expect(listenerCount(SID)).toBe(0)
  }, 20_000)

  it('keeps the listener of a throttled background tab (one probe per minute)', async () => {
    // Chrome throttles a hidden tab's timers to ~1/min, so the 15s nominal
    // probe interval stretches. A 40s threshold would kill this tab's listener
    // while the user is just looking at another tab; 3min tolerates it.
    const ws = await connect()
    await subscribe(ws, SID)

    // Six throttled minutes — deliberately past 2x the 3min threshold. Running
    // only ~3min would pass even if inbound frames did NOT refresh the stamp
    // (total elapsed would just graze the limit), so the test would assert
    // nothing; at 6min the listener survives only because each probe resets it.
    for (let minute = 0; minute < 6; minute++) {
      await advanceServerClock(60_000)
      expect(listenerCount(SID)).toBe(1)
      clientPing(ws)
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(listenerCount(SID)).toBe(1)
  }, 30_000)

  it('a normal close still releases its listener (no regression in the happy path)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)
    await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close() })
    // Give the server's close handler a tick.
    await vi.advanceTimersByTimeAsync(50)
    expect(listenerCount(SID)).toBe(0)
  })
})

describe('session:clear listener lifecycle (audit A-H1)', () => {
  /** One clear round trip: send session:clear, resolve on session:cleared. */
  function clearSession(ws: WebSocket, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const onMsg = (raw: Buffer) => {
        if ((JSON.parse(raw.toString('utf-8')) as { type?: string }).type === 'session:cleared') {
          ws.off('message', onMsg)
          resolve()
        }
      }
      ws.on('message', onMsg)
      ws.send(JSON.stringify({ type: 'session:clear', sessionId }))
    })
  }

  it('clear releases the listener — repeated New-session clicks must not accumulate', async () => {
    // The old handler re-registered a background bgHandler on every clear and
    // threw away its unsubscribe (and nothing ever drained its pendingEvents),
    // so each admin "New session" click leaked one listener on the old session
    // — the accumulation confirmed by production probes (3 listeners on one
    // session). A cleared session needs NO listener: the admin wipes its chat
    // store on session:cleared, SessionUIStore folds + persists a running
    // session's events with zero listeners, and a later re-open subscribes
    // fresh from the snapshot.
    const ws = await connect()
    await subscribe(ws, SID)
    expect(listenerCount(SID)).toBe(1)

    await clearSession(ws, SID)
    expect(listenerCount(SID)).toBe(0)

    // Subscribe→clear ×3 (the production accumulation signature): count must
    // return to zero every time, not grow by one per cycle.
    for (let i = 0; i < 3; i++) {
      await subscribe(ws, SID)
      expect(listenerCount(SID)).toBe(1)
      await clearSession(ws, SID)
    }
    expect(listenerCount(SID)).toBe(0)
  })
})

describe('self-heal after reclaim', () => {
  // A reclaimed-but-alive connection (renderer frozen >3min, network process
  // still answering pings) has NO path back on its own: the server keeps
  // answering `__pong__`, so the client's staleness clock stays fresh and its
  // zombie detection / visibility probe never fire. Both recovery signals
  // below exist so a resumed tab doesn't sit silently dead until F5.

  it('emits listener:released on the reclaimed connection (the resume-time recovery signal)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    const frames: Array<Record<string, unknown>> = []
    ws.on('message', (raw: Buffer) => { frames.push(JSON.parse(raw.toString('utf-8')) as Record<string, unknown>) })

    // Silent past the threshold → reclaim. A frozen tab wouldn't read the
    // frame until resume; the recorder standing in for "resume" changes
    // nothing server-side (receiving refreshes no server state).
    await advanceServerClock(4 * 60_000)
    expect(listenerCount(SID)).toBe(0)

    const released = frames.filter((f) => f.type === 'listener:released')
    expect(released).toHaveLength(1)
    expect(released[0]!.sessionId).toBe(SID)
  }, 20_000)

  it('a chat after reclaim re-registers the listener (no blind agent run)', async () => {
    const ws = await connect()
    await subscribe(ws, SID)
    await advanceServerClock(4 * 60_000)
    expect(listenerCount(SID)).toBe(0)

    // The freeze window overlapped a long compact — realistic, and it keeps
    // handleChat on the enqueue path so no model runtime is built in tests.
    const sm = registry.getOrCreate(workspace)
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions
      .set(SID, { isCompacting: true, messageQueue: [] })

    // Frame waits are promise-based (same as `subscribe()` above): a chat is a
    // real client→server→client round trip, and advancing the FAKE clock does
    // not push bytes through real sockets — asserting after a fake-time wait
    // raced the TCP hop and flaked.
    const frames: Array<Record<string, unknown>> = []
    const arrived = new Map<string, () => void>()
    ws.on('message', (raw: Buffer) => {
      const f = JSON.parse(raw.toString('utf-8')) as Record<string, unknown>
      frames.push(f)
      arrived.get(f.type as string)?.()
    })
    const frame = (type: string) => new Promise<void>((r) => arrived.set(type, r))

    // Resume: the user types into the tab. The connection is still bound to
    // the SAME sessionId (reclaim keeps the binding), so before the
    // `|| !client.unsubscribeEvents` hardening this matched neither bind
    // branch — the agent ran while this connection received nothing.
    const queued = frame('chat:queued')
    ws.send(JSON.stringify({ type: 'chat', sessionId: SID, projectId: workspace, message: 'still there?' }))
    await queued

    expect(listenerCount(SID)).toBe(1)

    // And the re-registered listener actually feeds this connection.
    const streamed = frame('chat:stream')
    ;(sm as unknown as { uiStore: { emitEvent: (s: string, e: unknown) => void } })
      .uiStore.emitEvent(SID, { type: 'stream', text: 'welcome back', agentName: 'default' })
    await streamed
    expect(frames.filter((f) => f.type === 'chat:stream')).toHaveLength(1)
  }, 20_000)
})
