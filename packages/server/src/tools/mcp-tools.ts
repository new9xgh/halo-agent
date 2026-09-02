/**
 * MCP tools — connect to user-declared MCP servers and expose their tools
 * as halo `ToolDef`s.
 *
 * Servers are declared in `~/.halo/global/mcp/<id>.yaml` (overlaid by
 * `<ws>/.halo/mcp/<id>.yaml`) and loaded via `loadMcpServers()` in config.ts.
 * Each MCP tool becomes a ToolDef named `mcp__<serverId>__<toolName>` so it
 * can never collide with built-in tools in AgentLoop's toolMap. All 11
 * provider agent classes consume the same ToolDef[] — nothing per-provider
 * is needed here.
 *
 * Client lifecycle: one pooled `Client` per (workspaceRoot, serverId),
 * connected lazily on first session build and reused across sessions. A
 * config change (fingerprint mismatch) drops the old client and reconnects.
 * A server that fails to connect/list is skipped with a log line — it never
 * blocks session creation. Stdio children exit on stdin EOF when the halo
 * process exits, so no explicit shutdown hook is needed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '../config.js'
import { cleanChildEnv } from '../child-env.js'
import { TOOL_ERROR_MARKER, type ToolDef, type ToolResultBlock } from '../agents/agent-loop.js'

const CONNECT_TIMEOUT_MS = 10_000

/** One tool as reported by the MCP server's tools/list. */
interface McpToolMeta {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  /** MCP `annotations.readOnlyHint` — used to filter readonly sessions. */
  readOnly: boolean
}

interface PooledClient {
  client: Client
  tools: McpToolMeta[]
}

/** Pool entry keyed by `${workspaceRoot}:${serverId}`; the fingerprint is the
 *  serialized server config so an edited yaml triggers a reconnect. The
 *  connect promise is stored (not its result) so concurrent session builds
 *  share one connection attempt. */
const pool = new Map<string, { fingerprint: string; ready: Promise<PooledClient | null> }>()

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

/** Child env for stdio servers: the halo process env minus its own auth
 *  secrets (cleanChildEnv), overlaid with the yaml-declared env. */
function childEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(cleanChildEnv())) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.assign(out, extra)
}

async function connect(cfg: McpServerConfig, workspaceRoot: string): Promise<PooledClient | null> {
  try {
    const client = new Client({ name: 'halo-mcp-client', version: '1.0.0' })
    const transport = cfg.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(cfg.url!), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        })
      : new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args,
          env: childEnv(cfg.env),
          cwd: workspaceRoot || undefined, // empty → inherit process cwd (probe without a workspace)
        })
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect to MCP server "${cfg.id}"`)
    const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `list tools of MCP server "${cfg.id}"`)
    return {
      client,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        readOnly: t.annotations?.readOnlyHint === true,
      })),
    }
  } catch (err) {
    console.log(`[mcp] Skipping server "${cfg.id}": ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function getPooled(workspaceRoot: string, cfg: McpServerConfig): Promise<PooledClient | null> {
  const key = `${workspaceRoot}:${cfg.id}`
  const fingerprint = JSON.stringify(cfg)
  const hit = pool.get(key)
  if (hit && hit.fingerprint === fingerprint) return hit.ready
  if (hit) {
    // Config changed — close the stale client once its connect settles, then
    // reconnect below. Best-effort: a wedged close must not block the pool.
    void hit.ready.then((p) => p?.client.close().catch(() => {})).catch(() => {})
    pool.delete(key)
  }
  const entry = { fingerprint, ready: connect(cfg, workspaceRoot) }
  pool.set(key, entry)
  return entry.ready
}

async function callMcpTool(client: Client, serverId: string, toolName: string, input: unknown): Promise<string | ToolResultBlock[]> {
  try {
    const result = await client.callTool({
      name: toolName,
      arguments: (input ?? {}) as Record<string, unknown>,
    })
    const blocks: ToolResultBlock[] = []
    for (const c of (result.content ?? []) as Array<Record<string, unknown>>) {
      if (c.type === 'text') {
        blocks.push({ type: 'text', text: String(c.text) })
      } else if (c.type === 'image') {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: String(c.mimeType), data: String(c.data) } })
      } else {
        // audio / resource / anything else the loop can't render — degrade to text
        blocks.push({ type: 'text', text: JSON.stringify(c) })
      }
    }
    if (result.isError) {
      const msg = blocks.map((b) => (b.type === 'text' ? b.text : `[image ${b.source.media_type}]`)).join('\n')
      return `${TOOL_ERROR_MARKER}\nMCP tool "${serverId}/${toolName}" failed: ${msg || '(no content)'}`
    }
    if (blocks.length === 0) return '(no content)'
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text
    return blocks
  } catch (err) {
    return `${TOOL_ERROR_MARKER}\nMCP tool "${serverId}/${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface McpToolSet {
  tools: ToolDef[]
  /** Names (already `mcp__`-prefixed) of tools annotated `readOnlyHint` —
   *  the only ones a readonly session may keep. */
  readOnlyNames: Set<string>
}

/**
 * Connect to every declared MCP server (in parallel, each with its own
 * timeout) and convert their tool lists into ToolDefs. Servers that fail
 * are skipped — check the server log for `[mcp] Skipping server ...`.
 */
export async function createMcpTools(workspaceRoot: string, servers: McpServerConfig[]): Promise<McpToolSet> {
  const tools: ToolDef[] = []
  const readOnlyNames = new Set<string>()
  const pooled = await Promise.all(servers.map((s) => getPooled(workspaceRoot, s)))
  for (let i = 0; i < servers.length; i++) {
    const p = pooled[i]
    if (!p) continue
    const serverId = servers[i].id
    for (const t of p.tools) {
      const name = `mcp__${serverId}__${t.name}`
      if (t.readOnly) readOnlyNames.add(name)
      tools.push({
        name,
        description: `[${serverId}] ${t.description ?? t.name}`,
        inputSchema: t.inputSchema,
        callback: (input) => callMcpTool(p.client, serverId, t.name, input),
      })
    }
  }
  return { tools, readOnlyNames }
}

/** Test hook: close every pooled client and clear the pool. */
export async function closeAllMcpClients(): Promise<void> {
  const entries = [...pool.values()]
  pool.clear()
  await Promise.all(entries.map((e) => e.ready.then((p) => p?.client.close().catch(() => {})).catch(() => {})))
}

/** Close and drop the pooled client for one server — called by the admin
 *  routes after a yaml edit / delete / toggle so the next session build
 *  reconnects with the new config. `workspaceRoot` of null closes the
 *  server across EVERY workspace (a global-yaml edit affects them all).
 *  No-op when nothing is pooled. */
export async function closeMcpClient(workspaceRoot: string | null, serverId: string): Promise<void> {
  const suffix = `:${serverId}`
  const keys = workspaceRoot === null
    ? [...pool.keys()].filter((k) => k.endsWith(suffix))
    : [`${workspaceRoot}${suffix}`]
  await Promise.all(keys.map(async (key) => {
    const hit = pool.get(key)
    if (!hit) return
    pool.delete(key)
    await hit.ready.then((p) => p?.client.close().catch(() => {})).catch(() => {})
  }))
}

/** Read-only pool snapshot for one workspace: serverId → tool count, for
 *  every server whose connect already succeeded. Servers never connected
 *  (or failed) are absent — the admin list shows no count for them and
 *  offers probe instead. */
export async function getMcpPoolStatus(workspaceRoot: string): Promise<Map<string, { toolCount: number }>> {
  const out = new Map<string, { toolCount: number }>()
  const prefix = `${workspaceRoot}:`
  await Promise.all([...pool.entries()].map(async ([key, entry]) => {
    if (!key.startsWith(prefix)) return
    const p = await entry.ready.catch(() => null)
    if (p) out.set(key.slice(prefix.length), { toolCount: p.tools.length })
  }))
  return out
}

export interface McpProbeResult {
  ok: boolean
  toolCount?: number
  tools?: Array<{ name: string; readOnly: boolean }>
  error?: string
}

/**
 * One-shot connectivity check for the admin "test connection" button.
 * Uses a fresh, unpooled connection that is closed before returning, so
 * probing never disturbs the shared pool.
 */
export async function probeMcpServer(workspaceRoot: string, cfg: McpServerConfig): Promise<McpProbeResult> {
  const p = await connect(cfg, workspaceRoot)
  if (!p) return { ok: false, error: `connect failed (see server log for [mcp] Skipping server "${cfg.id}")` }
  try {
    return {
      ok: true,
      toolCount: p.tools.length,
      tools: p.tools.map((t) => ({ name: t.name, readOnly: t.readOnly })),
    }
  } finally {
    await p.client.close().catch(() => {})
  }
}
