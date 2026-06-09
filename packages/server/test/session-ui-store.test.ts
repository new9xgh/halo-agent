import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSessionEvent } from '../src/agents/agent-events.js'
import type { UIState } from '../src/sessions/ui-log-builder.js'

// broadcast is a module-level singleton over the live WSS; stub it so the
// `complete` → session:changed contract can be asserted without a server.
const broadcastSpy = vi.fn()
vi.mock('../src/ws/broadcast.js', () => ({ broadcast: (e: Record<string, unknown>) => broadcastSpy(e) }))
// session-store touches disk for seeding/persisting; the store under test only
// calls persistSessionFile through the host, but ensureUIState reads via
// loadSessionMessages. Stub the lot to keep this a pure in-memory unit test.
vi.mock('../src/sessions/session-store.js', () => ({
  getSessionDir: () => '/tmp/none',
  loadSessionMessages: () => [],
  fileSegment: (id: string) => id,
}))

const { SessionUIStore } = await import('../src/agents/session-ui-store.js')
type Host = ConstructorParameters<typeof SessionUIStore>[0]

/**
 * Characterization tests for SessionUIStore — the event-routing + UI-log
 * cluster carved out of SessionManager. These pin the behaviors the carve-out
 * had to preserve byte-for-byte: listeners observe post-reduce state, `complete`
 * is the admin-list refresh hook, the tombstone blocks sub-session writes, and
 * getUIState honours the host's existence check. A silent regression in any of
 * these reproduces the "UI just stops updating" class of bug.
 */

/** Fake host: no db row by default, records every persistSessionFile call. */
function makeHost(over: Partial<Host> = {}): { host: Host; persisted: Array<{ sessionId: string }> } {
  const persisted: Array<{ sessionId: string }> = []
  const host: Host = {
    workspaceRoot: '/ws',
    // ensureUIState calls db.select()...get(); return null row → empty state, no disk seed.
    getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => null }) }) }) }) as never,
    getSession: () => undefined,
    getSessionById: () => null,
    isSessionDeleted: () => false,
    persistSessionFile: (opts) => { persisted.push(opts as { sessionId: string }) },
    ...over,
  }
  return { host, persisted }
}

beforeEach(() => {
  broadcastSpy.mockClear()
})

describe('SessionUIStore event routing', () => {
  it('listener receives the state AFTER the event is reduced in', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    let seen: UIState | null = null
    store.registerEventListener('s1', (_e, state) => { seen = state })

    store.emitEvent('s1', { type: 'user', text: 'hello' } as AgentSessionEvent)

    // The user message must already be in the log the listener sees — emitEvent
    // reduces before fanning out. (Capturing turnId BEFORE the reduce but state
    // AFTER is the exact shape the comment in emitEvent documents.)
    expect(seen).not.toBeNull()
    expect((seen as unknown as UIState).messageLog.at(-1)).toMatchObject({ role: 'user', content: 'hello' })
  })

  it('complete event fires broadcast(session:changed) and reaches the listener', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const events: string[] = []
    store.registerEventListener('s1', (e) => { events.push(e.type) })

    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)

    expect(broadcastSpy).toHaveBeenCalledWith({ type: 'session:changed' })
    expect(events).toContain('complete')
  })

  it('a non-complete event does NOT broadcast session:changed', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(broadcastSpy).not.toHaveBeenCalled()
  })

  it('falls back to the global handler when no per-tree listener is registered', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const seen: string[] = []
    store.setEventHandler((e) => { seen.push(e.type) })

    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(seen).toEqual(['user'])
  })

  it('unsubscribe removes the listener; later events hit the global handler', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const perTree: string[] = []
    const global: string[] = []
    const unsub = store.registerEventListener('s1', (e) => { perTree.push(e.type) })
    store.setEventHandler((e) => { global.push(e.type) })

    store.emitEvent('s1', { type: 'user', text: 'a' } as AgentSessionEvent)
    unsub()
    store.emitEvent('s1', { type: 'user', text: 'b' } as AgentSessionEvent)

    expect(perTree).toEqual(['user'])   // only the first
    expect(global).toEqual(['user'])    // only the second, after unsubscribe
  })

  it('routes a sub-session event to the ROOT tree listener (id auto-normalized)', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    const events: AgentSessionEvent[] = []
    store.registerEventListener('root', (e) => { events.push(e) })

    // agent_start with taskId seeds the sub-log; emit it on the root id.
    store.emitEvent('root', { type: 'agent_start', agentName: 'sub', agentId: 'a', text: 't', taskId: 'root>child', sessionId: 'root>child' } as AgentSessionEvent)
    expect(events.map((e) => e.type)).toContain('agent_start')
  })
})

describe('SessionUIStore persistence + tombstone', () => {
  it('complete event flushes the root UI log to disk synchronously', () => {
    const { host, persisted } = makeHost()
    const store = new SessionUIStore(host)
    // Seed a message so the snapshot is non-empty (persistUIState skips empties).
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    store.emitEvent('s1', { type: 'complete' } as AgentSessionEvent)
    expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
  })

  it('user event persists via the 500ms debounce, not synchronously', () => {
    vi.useFakeTimers()
    try {
      const { host, persisted } = makeHost()
      const store = new SessionUIStore(host)
      store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
      // Debounced path: nothing on disk yet.
      expect(persisted).toHaveLength(0)
      vi.advanceTimersByTime(500)
      expect(persisted.some((p) => p.sessionId === 's1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('tombstoned root blocks its sub-session writes', () => {
    const { host, persisted } = makeHost({ isSessionDeleted: (id) => id === 'root' })
    const store = new SessionUIStore(host)
    // Seed a sub-log, then drive a completion that would persist it.
    store.emitEvent('root', { type: 'agent_start', agentName: 'sub', agentId: 'a', text: 't', taskId: 'root>child', sessionId: 'root>child' } as AgentSessionEvent)
    store.emitEvent('root', { type: 'agent_done', agentName: 'sub', taskId: 'root>child' } as AgentSessionEvent)
    // No persisted entry should target the sub-session — tombstone short-circuits.
    expect(persisted.some((p) => p.sessionId === 'root>child')).toBe(false)
  })
})

describe('SessionUIStore UIState access', () => {
  it('getUIState returns null when the host has no such session', () => {
    const { host } = makeHost({ getSessionById: () => null })
    const store = new SessionUIStore(host)
    expect(store.getUIState('ghost')).toBeNull()
  })

  it('getUIState builds state when the host knows the session', () => {
    const { host } = makeHost({ getSessionById: () => ({ agentId: 'a', agentName: 'A' }) })
    const store = new SessionUIStore(host)
    const state = store.getUIState('s1')
    expect(state).not.toBeNull()
    expect(state!.messageLog).toEqual([])
  })

  it('getCachedUIState returns null until an event builds the state', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    expect(store.getCachedUIState('s1')).toBeNull()
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(store.getCachedUIState('s1')).not.toBeNull()
  })

  it('dropUIState evicts the cached state', () => {
    const { host } = makeHost()
    const store = new SessionUIStore(host)
    store.emitEvent('s1', { type: 'user', text: 'hi' } as AgentSessionEvent)
    expect(store.getCachedUIState('s1')).not.toBeNull()
    store.dropUIState('s1')
    expect(store.getCachedUIState('s1')).toBeNull()
  })
})
