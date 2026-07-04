/**
 * Amazon Bedrock AgentCore Runtime adapter.
 *
 * Mounted ONLY when `HALO_RUNTIME_MODE=agentcore` (see index.ts). AgentCore
 * fronts the container and terminates auth (SigV4 / OAuth) before any request
 * reaches us, so these endpoints are intentionally unauthenticated — the
 * container is never directly reachable in a real deployment.
 *
 * Contract implemented:
 *   GET  /ping         → {"status":"healthy"}          (health check)
 *   POST /invocations  → {"input":{"prompt"}} in, full assistant message out
 *   WS   /ws           → bidirectional streaming (the primary path):
 *     client → server: {"inputText":"..."} | {"type":"stop"}
 *     server → client: {"type":"history"|"stream"|"thinking"|"tool_call"
 *                        |"tool_result"|"queued"|"complete"|"error", ...}
 *     (`history` replays the session's persisted conversation right after
 *      connect, so a returning client restores its chat before live events)
 *
 * Session identity comes from the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`
 * header (AgentCore sets it) or a `sessionId` query param (browser WS can't
 * set headers). The id maps 1:1 onto a persistent halo session, so a client
 * reconnecting with the same id resumes its conversation.
 */
import { Hono } from 'hono'
import path from 'node:path'
import fs from 'node:fs'
import type { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionManager } from '../agents/session-manager.js'
import type { AgentSessionEvent } from '../agents/agent-events.js'
import { resolveDefaultAgentId, dispatchCommand, type CommandContext } from '../channels/shared/commands.js'
import { createSaveSnapshot } from '../sessions/ui-log-builder.js'
import { inferMessageType } from '../sessions/session-types.js'

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'

/** Map an AgentCore runtime session id onto a halo session id. Sanitized to
 *  the charset halo uses in session file names; capped so filenames stay sane. */
function haloSessionId(runtimeSessionId: string): string {
  return `agentcore_${runtimeSessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)}`
}

/** Per-user workspace: `<base>/users/<sanitized runtime session id>/`.
 *  One runtime session id (= one demo user) owns one directory — its own
 *  `.halo/` (sqlite db + session files) lives inside, so user data is fully
 *  isolated and persists on the EFS mount backing the base path. */
function userWorkspace(base: string, runtimeSessionId: string): string {
  const dir = path.join(base, 'users', runtimeSessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Create the halo session on first contact; no-op when it already exists.
 *  Entry agent resolution matches every other channel (resolveDefaultAgentId). */
async function ensureSession(sm: SessionManager, workspace: string, sessionId: string): Promise<void> {
  if (sm.getSessionById(sessionId)) return
  const agentId = await resolveDefaultAgentId(sm, workspace)
  await sm.createSession(agentId, null, 'AgentCore Runtime', undefined, sessionId)
}

/** Run one turn and collect the full text response (non-streaming
 *  /invocations path). Resolves on the terminal `complete` / `error`. */
function runTurnCollect(sm: SessionManager, sessionId: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const unsubscribe = sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
      if (event.taskId) return
      if (event.type === 'stream') {
        text += event.text ?? ''
      } else if (event.type === 'complete' && !event.batchBoundary) {
        unsubscribe()
        resolve(text)
      } else if (event.type === 'error') {
        unsubscribe()
        resolve(text ? `${text}\n\n[error] ${event.error}` : `[error] ${event.error ?? 'unknown error'}`)
      }
    })
    sm.appendUserMessage(sessionId, prompt)
    sm.sendUserMessage(sessionId, `[channel: agentcore]\n\n${prompt}`)
      .then((result) => {
        if (result === 'queued') {
          // Session busy with a previous turn — the message is queued and will
          // fold into that turn. Non-streaming callers can't wait for it.
          unsubscribe()
          resolve('(agent busy — message queued and will be processed with the current turn)')
        }
      })
      .catch((err) => { unsubscribe(); reject(err) })
  })
}

export function createAgentCoreRoutes(deps: { registry: SessionManagerRegistry; workspace: string }): Hono {
  const { registry, workspace } = deps
  const app = new Hono()

  app.get('/ping', (c) => {
    // Per-user workspaces: any loaded SessionManager with a running session
    // means the runtime is busy.
    const busy = registry.list().some(({ sm }) => sm.hasRunningSessions())
    return c.json({ status: busy ? 'HealthyBusy' : 'Healthy' })
  })

  app.post('/invocations', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { input?: { prompt?: string } }
    const prompt = typeof body.input?.prompt === 'string' ? body.input.prompt.trim() : ''
    if (!prompt) return c.json({ error: 'input.prompt required' }, 400)

    const runtimeSessionId = c.req.header(SESSION_HEADER) || `inv-${Date.now().toString(36)}`
    const sessionId = haloSessionId(runtimeSessionId)
    const userWs = userWorkspace(workspace, runtimeSessionId)
    const sm = registry.getOrCreate(userWs)
    await ensureSession(sm, userWs, sessionId)

    const text = await runTurnCollect(sm, sessionId, prompt)
    return c.json({ output: { message: { role: 'assistant', content: [{ text }] } } })
  })

  return app
}

/**
 * History frame payload: the session's persisted conversation slimmed to
 * what the demo frontend renders — user bubbles + assistant turns with
 * thinking / tool-call steps. Debug system messages (usage, tool echo
 * duplicates) stay server-side; tool outputs truncate to 500 chars to
 * match the live `tool_result` frames.
 */
function buildHistory(sm: SessionManager, sessionId: string): { messages: Array<Record<string, unknown>>; running: boolean } {
  const state = sm.getUIState(sessionId)
  if (!state) return { messages: [], running: false }
  const messages: Array<Record<string, unknown>> = []
  for (const m of createSaveSnapshot(state)) {
    if (m.taskId) continue // sub-agent scoped — live listener filters these too
    const type = inferMessageType(m)
    if (type !== 'user' && type !== 'assistant') continue
    const blocks: Array<Record<string, unknown>> = []
    for (const b of m.contentBlocks ?? []) {
      // Text blocks are omitted — `content` already carries the full text.
      if (b.type === 'thinking') {
        blocks.push({ type: 'thinking', text: b.text })
      } else if (b.type === 'tool_call') {
        blocks.push({ type: 'tool_call', toolCall: { name: b.toolCall.name, input: b.toolCall.input, output: b.toolCall.output?.slice(0, 500) } })
      }
    }
    messages.push({
      role: m.role,
      content: m.content,
      ts: m.timestamp,
      ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
    })
  }
  return { messages, running: sm.isSessionRunning(sessionId) }
}

/**
 * WebSocket /ws — the streaming path. One connection maps to one halo
 * session (id from header/query). A single connection-scoped event listener
 * forwards agent events for the connection's lifetime, so:
 *   - multiple turns stream over one socket,
 *   - a message sent while the agent is busy gets queued server-side
 *     (sendUserMessage → 'queued') and its eventual output still reaches
 *     the client through the same listener.
 *
 * Connect-time behavior: the server immediately replays the session's
 * persisted conversation as a `history` frame (empty for fresh ids — the
 * session itself is created lazily on first message). For existing sessions
 * the event listener attaches at connect too, so a client reconnecting
 * while a turn is still running resumes the live stream after the replay.
 */
/** Tracks /session switch overrides per user (runtimeSessionId → halo sessionId). */
const activeOverrides = new Map<string, string>()

export function setupAgentCoreWebSocket(deps: { wss: WebSocketServer; registry: SessionManagerRegistry; workspace: string }): void {
  const { wss, registry, workspace } = deps

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost')
    const runtimeSessionId =
      (req.headers[SESSION_HEADER] as string | undefined)
      || url.searchParams.get('sessionId')
      || `ws-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    let sessionId = haloSessionId(runtimeSessionId)
    const userWs = userWorkspace(workspace, runtimeSessionId)
    const sm = registry.getOrCreate(userWs)

    const send = (obj: Record<string, unknown>): void => {
      if (ws.readyState !== ws.OPEN) return
      try { ws.send(JSON.stringify(obj)) } catch { /* closing socket — drop */ }
    }

    let unsubscribe: (() => void) | null = null
    const attachListener = (): void => {
      unsubscribe ??= sm.registerEventListener(sessionId, (event: AgentSessionEvent) => {
        if (event.taskId) return
        switch (event.type) {
          case 'stream':
            if (event.text) send({ type: 'stream', text: event.text })
            break
          case 'thinking':
            send({ type: 'thinking', text: event.text ?? '' })
            break
          case 'tool_call':
            send({ type: 'tool_call', toolName: event.toolName, toolInput: event.toolInput })
            break
          case 'tool_result':
            send({ type: 'tool_result', toolName: event.toolName, result: event.toolResult?.slice(0, 500) })
            break
          case 'complete':
            // Batch-boundary completes are per-turn flushes while queued
            // messages drain — only the terminal complete ends the response.
            if (!event.batchBoundary) send({ type: 'complete' })
            break
          case 'error':
            send({ type: 'error', error: event.error ?? 'unknown error' })
            break
        }
      })
    }

    // Serialize session creation: two rapid first messages must not both
    // call createSession with the same explicit id.
    let ready: Promise<void> | null = null
    const ensureOnce = (): Promise<void> => {
      ready ??= ensureSession(sm, userWs, sessionId).then(() => attachListener())
      return ready
    }

    // NOTE: AgentCore's WS proxy only forwards frames that are responses
    // to client messages — server-initiated pushes on connect are dropped.
    // History replay is triggered by the client sending a {"type":"init"}
    // message after open (see ws.on('message') handler below).

    ws.on('message', (raw) => {
      let msg: { inputText?: string; type?: string }
      try {
        msg = JSON.parse(String(raw)) as { inputText?: string; type?: string }
      } catch {
        send({ type: 'error', error: 'invalid JSON' })
        return
      }

      // Client sends {"type":"init"} OR {"inputText":"/init"} after open to
      // request history replay. Both forms are accepted because AgentCore's
      // proxy may alter frames with non-standard shapes.
      if (msg.type === 'init' || (typeof msg.inputText === 'string' && msg.inputText.trim() === '/init')) {
        if (sm.getSessionById(sessionId)) {
          attachListener()
          send({ type: 'history', ...buildHistory(sm, sessionId) })
        } else {
          send({ type: 'history', messages: [], running: false })
        }
        return
      }

      if (msg.type === 'stop') {
        if (!sm.getSessionById(sessionId)) return
        sm.stopSession(sessionId).catch((err) => {
          send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
        })
        return
      }

      const text = typeof msg.inputText === 'string' ? msg.inputText.trim() : ''
      if (!text) {
        // Silently ignore frames without inputText — AgentCore proxy may send
        // internal frames (heartbeats, metadata) that have no user content.
        return
      }

      // Slash commands — handle locally, don't send to agent
      if (text.startsWith('/')) {
        void (async () => {
          try {
            await ensureOnce()
            const spaceIdx = text.indexOf(' ')
            const command = spaceIdx === -1 ? text : text.slice(0, spaceIdx)
            const arg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
            const ctx: CommandContext = {
              sm,
              userId: runtimeSessionId,
              sessionPrefix: 'agentcore_',
              accessLevel: 'full',
              channelLabel: 'AgentCore Runtime',
              activeOverrides,
              workspacePath: userWs,
              lang: 'en',
            }
            const cmdResult = await dispatchCommand(ctx, command, arg, { channelName: 'agentcore' })
            if (cmdResult) {
              send({ type: 'stream', text: cmdResult.text })
              if (cmdResult.switchTo) {
                // Re-bind the WS connection to the new session
                unsubscribe?.()
                unsubscribe = null
                sessionId = cmdResult.switchTo
                attachListener()
                // Tell the client to clear its chat and render fresh history
                send({ type: 'switch' })
                send({ type: 'history', ...buildHistory(sm, sessionId) })
              }
              if (cmdResult.startedTurn && cmdResult.sessionId) {
                // Skill activation kicked the agent on a (possibly different) session
                if (cmdResult.sessionId !== sessionId) {
                  unsubscribe?.()
                  unsubscribe = null
                  sessionId = cmdResult.sessionId
                  attachListener()
                }
              } else {
                send({ type: 'complete' })
              }
            } else {
              send({ type: 'stream', text: `Unknown command: ${command}` })
              send({ type: 'complete' })
            }
          } catch (err) {
            send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
          }
        })()
        return
      }

      void (async () => {
        try {
          await ensureOnce()
          sm.appendUserMessage(sessionId, text)
          const result = await sm.sendUserMessage(sessionId, `[channel: agentcore]\n\n${text}`)
          if (result === 'queued') send({ type: 'queued' })
        } catch (err) {
          send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
        }
      })()
    })

    ws.on('close', () => {
      unsubscribe?.()
      unsubscribe = null
    })

    console.log(`[AgentCore] ws connected — session ${sessionId}`)
  })
}
