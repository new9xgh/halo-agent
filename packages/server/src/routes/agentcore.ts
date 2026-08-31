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
 *     client → server: {"inputText":"...", "imageRefs"?: ["<uploadId>", ...]}
 *                       | {"inputText":"", "type":"image_chunk", ...}
 *                       | {"type":"stop"}
 *     (images arrive as chunked uploads — see the chunk-protocol block
 *      below; every frame carries inputText because the AgentCore WS proxy
 *      only forwards inputText frames)
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
import { saveInboundMedia } from '../channels/shared/media-store.js'

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id'

/** Charset-sanitize a runtime session id for use in file / session names. */
function sanitizeRuntimeId(runtimeSessionId: string): string {
  return runtimeSessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80)
}

/** Map an AgentCore runtime session id onto a halo session id. Sanitized to
 *  the charset halo uses in session file names; capped so filenames stay sane. */
function haloSessionId(runtimeSessionId: string): string {
  return `agentcore_${sanitizeRuntimeId(runtimeSessionId)}`
}

/** Per-user workspace: `<base>/users/<sanitized runtime session id>/`.
 *  One runtime session id (= one demo user) owns one directory — its own
 *  `.halo/` (sqlite db + session files) lives inside, so user data is fully
 *  isolated and persists on the EFS mount backing the base path. */
function userWorkspace(base: string, runtimeSessionId: string): string {
  const dir = path.join(base, 'users', sanitizeRuntimeId(runtimeSessionId))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Chunked image upload protocol.
 *
 *  The AgentCore WS proxy hard-caps a frame at 64KB — an oversized frame gets
 *  the connection cut with close 1009 "Policy violated: message size limit of
 *  64 KB for a message frame is exceeded" (verified against the Tokyo prod
 *  runtime), so images cannot ride inline in the message frame. Instead the
 *  client slices each image's base64 into ≤48KB chunk frames:
 *
 *    {"inputText":"", "type":"image_chunk", "uploadId":"u1",
 *     "seq":0, "total":8, "mimeType":"image/jpeg", "data":"<base64 slice>"}
 *
 *  (inputText rides along empty because the proxy only forwards frames that
 *  carry it), then references the assembled upload(s) from the message frame:
 *
 *    {"inputText":"...", "imageRefs":["u1"]}
 *
 *  Chunk assembly is per-connection, in-memory only — a dropped connection
 *  discards partial uploads and the client re-sends (no persistence by
 *  design). The socket is an external input boundary, hence the limits. */
const MAX_IMAGES_PER_MESSAGE = 4
const MAX_IMAGE_BASE64_LENGTH = 8 * 1024 * 1024 // 8MB of base64 ≈ 6MB binary
const MAX_PENDING_UPLOADS = 4 // concurrent uploads buffered per connection
const MAX_CHUNKS_PER_UPLOAD = 256 // 256 × 48KB ≈ 12MB ceiling before the 8MB check trips

type InboundImage = { data: string; mimeType: string }

interface PendingUpload {
  chunks: Array<string | undefined>
  received: number
  mimeType: string
  /** Total base64 length so far — checked against MAX_IMAGE_BASE64_LENGTH
   *  while chunks arrive, so an attacker can't buffer 256×48KB × 4 uploads. */
  size: number
}

/** Handle one `image_chunk` frame. Returns an error string for the client,
 *  or null when the chunk was accepted (no reply — replying per chunk would
 *  add N round-trips and the proxy forwards our frames fine mid-stream). */
function acceptChunk(uploads: Map<string, PendingUpload>, msg: Record<string, unknown>): string | null {
  const uploadId = msg.uploadId
  const seq = msg.seq
  const total = msg.total
  const mimeType = msg.mimeType
  const data = msg.data
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 64) return 'image_chunk: uploadId must be a non-empty string (≤64 chars)'
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return 'image_chunk: seq must be a non-negative integer'
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS_PER_UPLOAD) return `image_chunk: total must be 1..${MAX_CHUNKS_PER_UPLOAD}`
  if (typeof mimeType !== 'string' || typeof data !== 'string' || !data) return 'image_chunk: string mimeType and non-empty string data required'
  if (seq >= total) return 'image_chunk: seq out of range'

  let up = uploads.get(uploadId)
  if (!up) {
    if (uploads.size >= MAX_PENDING_UPLOADS) return `too many pending uploads (max ${MAX_PENDING_UPLOADS} per connection)`
    up = { chunks: new Array<string | undefined>(total), received: 0, mimeType, size: 0 }
    uploads.set(uploadId, up)
  }
  if (up.chunks.length !== total) return 'image_chunk: total mismatch across chunks of one uploadId'
  if (up.chunks[seq] !== undefined) return null // duplicate chunk (client retry) — ignore
  if (up.size + data.length > MAX_IMAGE_BASE64_LENGTH) {
    uploads.delete(uploadId) // poisoned — drop the whole upload
    return 'image too large (max 8MB base64 per image)'
  }
  up.chunks[seq] = data
  up.received++
  up.size += data.length
  return null
}

/** Resolve a message frame's `imageRefs` against completed uploads. Claims
 *  (removes) the uploads on success; on any error nothing is consumed so the
 *  client can fix and re-reference. */
function claimImageRefs(uploads: Map<string, PendingUpload>, raw: unknown): InboundImage[] | { error: string } {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return { error: 'imageRefs must be an array' }
  if (raw.length > MAX_IMAGES_PER_MESSAGE) return { error: `too many images (max ${MAX_IMAGES_PER_MESSAGE} per message)` }
  const images: InboundImage[] = []
  for (const ref of raw) {
    if (typeof ref !== 'string') return { error: 'imageRefs entries must be strings' }
    const up = uploads.get(ref)
    if (!up) return { error: `unknown uploadId: ${ref}` }
    if (up.received !== up.chunks.length) return { error: `upload ${ref} incomplete (${up.received}/${up.chunks.length} chunks)` }
    images.push({ data: up.chunks.join(''), mimeType: up.mimeType })
  }
  for (const ref of raw as string[]) uploads.delete(ref)
  return images
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

    // Per-connection chunked-image buffer (uploadId → partial upload). Freed
    // on close; never persisted — see the chunk-protocol comment up top.
    const uploads = new Map<string, PendingUpload>()

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>
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

      if (msg.type === 'image_chunk') {
        const err = acceptChunk(uploads, msg)
        if (err) send({ type: 'error', error: err })
        return
      }

      const text = typeof msg.inputText === 'string' ? msg.inputText.trim() : ''
      const claimed = claimImageRefs(uploads, msg.imageRefs)
      if (!Array.isArray(claimed)) {
        send({ type: 'error', error: claimed.error })
        return
      }
      const images = claimed
      if (!text && images.length === 0) {
        // Silently ignore frames without inputText/imageRefs — AgentCore proxy
        // may send internal frames (heartbeats, metadata) with no user content,
        // and the demo frontend's 30s keepalive ping lands here too.
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
              // Every slash command is open in this mode — by design: auth
              // terminates upstream at AgentCore (SigV4/OAuth, see file header),
              // so anyone who reaches this socket is already an authorized
              // owner of their isolated per-user workspace.
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
          // Persist inbound images into the user's workspace (same pattern as
          // telegram) so the agent can re-open them later via file tools; the
          // note marker also makes the image visible in history replay.
          const notes: string[] = []
          for (const img of images) {
            try {
              const savedPath = await saveInboundMedia({
                workspacePath: userWs, accountId: sanitizeRuntimeId(runtimeSessionId), channel: 'agentcore',
                buffer: Buffer.from(img.data, 'base64'), kind: 'image', mimeType: img.mimeType,
              })
              notes.push(`[图片已保存: ${savedPath}]`)
            } catch (err) {
              console.log(`[AgentCore] image save failed: ${err instanceof Error ? err.message : String(err)}`)
              notes.push('[图片]')
            }
          }
          const fullText = notes.length > 0 ? (text ? `${text}\n${notes.join('\n')}` : notes.join('\n')) : text
          sm.appendUserMessage(sessionId, fullText)
          const result = await sm.sendUserMessage(sessionId, `[channel: agentcore]\n\n${fullText}`, images.length > 0 ? images : undefined)
          if (result === 'queued') send({ type: 'queued' })
        } catch (err) {
          send({ type: 'error', error: err instanceof Error ? err.message : String(err) })
        }
      })()
    })

    ws.on('close', () => {
      unsubscribe?.()
      unsubscribe = null
      // Chunk buffers are connection-scoped — free them so abandoned uploads
      // (client crashed mid-upload) can't accumulate across reconnects.
      uploads.clear()
      // The override only matters while this socket is open (it's the "current
      // session" for its slash commands), and a reconnect re-resolves from the
      // session id — so drop it here rather than letting the map grow one entry
      // per runtime session for the container's lifetime.
      activeOverrides.delete(runtimeSessionId)
    })

    console.log(`[AgentCore] ws connected — session ${sessionId}`)
  })
}
