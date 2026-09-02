/**
 * MCP server management routes — CRUD over the `mcp/<id>.yaml`
 * declarations consumed by `loadMcpServers()` (config.ts) and the client
 * pool in tools/mcp-tools.ts.
 *
 * Mounted at /api (index.ts); auth middleware applies globally.
 * Conventions follow agent-configs.ts / skills.ts:
 *   - dual scope via `scope` ('global' | 'workspace') + `projectId`
 *     (absolute workspace path; required for workspace scope)
 *   - `:id` is validated with isSafeIdSegment before touching disk
 *   - yaml edits round-trip the raw text (Monaco edits the original, PUT
 *     writes it back verbatim) so comments survive
 *   - enable/disable lives in the yaml `enabled` field — the same flag
 *     loadMcpServers() filters on — NOT in the disabled_items table
 *
 * `globalDirOverride` exists for tests (avoid touching the real ~/.halo).
 */
import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { globalMcpDir, wsMcpDir } from '../paths.js'
import { parseMcpServerFile, parseMcpServerConfig } from '../config.js'
import { closeMcpClient, getMcpPoolStatus, probeMcpServer } from '../tools/mcp-tools.js'
import { badRequest, notFound, conflict } from './error.js'
import { isSafeIdSegment } from './workspace-path.js'

/** One server as the admin list sees it. */
interface McpServerListItem {
  id: string
  transport: 'stdio' | 'http'
  description?: string
  enabled: boolean
  scope: 'global' | 'workspace'
  /** global entry shadowed by a same-id workspace file. */
  overridden?: boolean
  /** tool count from the live pool; absent when not connected. */
  toolCount?: number
}

/** Atomic write (copied from agent-configs.ts): tmp + rename so a
 *  concurrent loadMcpServers never reads a truncated file. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`
  await fs.writeFile(tmpPath, content, 'utf-8')
  try {
    await fs.rename(tmpPath, filePath)
  } catch {
    await fs.writeFile(filePath, content, 'utf-8')
    await fs.rm(tmpPath, { force: true }).catch(() => { /* best-effort cleanup */ })
  }
}

export function createMcpRoutes(globalDirOverride?: string) {
  const app = new Hono()

  const globalDir = () => globalDirOverride ?? globalMcpDir()

  /** Resolve the mcp dir for a scope; returns null when workspace scope
   *  lacks projectId (caller turns that into a 400). */
  const dirFor = (scope: string | undefined, projectId: string | undefined): string | null => {
    if (scope === 'workspace') return projectId ? wsMcpDir(projectId) : null
    return globalDir()
  }

  /** Scan one mcp dir into list items (invalid files already logged +
   *  dropped by parseMcpServerFile). */
  const scanDir = async (dir: string, scope: 'global' | 'workspace'): Promise<McpServerListItem[]> => {
    const out: McpServerListItem[] = []
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch { return out } // dir missing — nothing declared
    for (const name of names.sort()) {
      if (!name.endsWith('.yaml')) continue
      const cfg = parseMcpServerFile(path.join(dir, name))
      if (!cfg) continue
      out.push({ id: cfg.id, transport: cfg.transport, description: cfg.description, enabled: cfg.enabled, scope })
    }
    return out
  }

  /** Read one server's yaml file; null when missing. */
  const readServerFile = async (dir: string, id: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(dir, `${id}.yaml`), 'utf-8')
    } catch { return null }
  }

  // ── List (both scopes, global overridden flags, pool tool counts) ──
  app.get('/mcp-servers', async (c) => {
    const projectId = c.req.query('projectId') || undefined
    const wsItems = projectId ? await scanDir(wsMcpDir(projectId), 'workspace') : []
    const wsIds = new Set(wsItems.map((s) => s.id))
    const globalItems = await scanDir(globalDir(), 'global')
    for (const item of globalItems) {
      if (wsIds.has(item.id)) item.overridden = true
    }
    if (projectId) {
      const poolStatus = await getMcpPoolStatus(projectId)
      for (const item of [...globalItems, ...wsItems]) {
        const st = poolStatus.get(item.id)
        if (st) item.toolCount = st.toolCount
      }
    }
    return c.json({ servers: [...globalItems, ...wsItems] })
  })

  // ── Create ─────────────────────────────────────────────────────────
  app.post('/mcp-servers', async (c) => {
    const body = await c.req.json<Record<string, unknown>>()
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return badRequest(c, 'id required')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const scope = body.scope === 'workspace' ? 'workspace' : 'global'
    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : undefined
    const dir = dirFor(scope, projectId)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')

    const cfg = parseMcpServerConfig({ ...body, id }, 'POST /mcp-servers')
    if (!cfg) return badRequest(c, 'invalid server config (stdio requires command, http requires url)')

    const filePath = path.join(dir, `${id}.yaml`)
    try {
      await fs.access(filePath)
      return conflict(c, `MCP server "${id}" already exists in ${scope} scope`)
    } catch { /* missing — good */ }

    // Cross-scope shadowing is legal (workspace overriding global is the
    // documented pattern) — report it, don't block.
    const otherDir = scope === 'global' ? (projectId ? wsMcpDir(projectId) : null) : globalDir()
    let conflictScope: string | undefined
    if (otherDir) {
      try {
        await fs.access(path.join(otherDir, `${id}.yaml`))
        conflictScope = scope === 'global' ? 'workspace' : 'global'
      } catch { /* no shadow */ }
    }

    const yaml = YAML.stringify(
      { id: cfg.id, transport: cfg.transport, command: cfg.command, args: cfg.args, env: cfg.env, url: cfg.url, headers: cfg.headers, description: cfg.description },
      { lineWidth: 120 },
    )
    await fs.mkdir(dir, { recursive: true })
    await writeFileAtomic(filePath, yaml)
    return c.json({ server: { id: cfg.id, transport: cfg.transport, description: cfg.description, enabled: true, scope }, ...(conflictScope ? { conflictScope } : {}) }, 201)
  })

  // ── Read raw yaml (Monaco round-trip) ──────────────────────────────
  app.get('/mcp-servers/:id/yaml', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const dir = dirFor(c.req.query('scope'), c.req.query('projectId') || undefined)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')
    const raw = await readServerFile(dir, id)
    if (raw === null) return notFound(c, `MCP server "${id}"`)
    return c.json({ yaml: raw })
  })

  // ── Save raw yaml ──────────────────────────────────────────────────
  app.put('/mcp-servers/:id/yaml', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const body = await c.req.json<{ yaml?: string; scope?: string; projectId?: string }>()
    if (typeof body.yaml !== 'string') return badRequest(c, 'yaml required')
    const dir = dirFor(body.scope, body.projectId)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')
    const filePath = path.join(dir, `${id}.yaml`)
    try {
      await fs.access(filePath)
    } catch { return notFound(c, `MCP server "${id}"`) }

    let parsed: unknown
    try {
      parsed = YAML.parse(body.yaml)
    } catch (err) {
      return badRequest(c, `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`)
    }
    const cfg = parseMcpServerConfig(parsed, `PUT /mcp-servers/${id}/yaml`)
    if (!cfg) return badRequest(c, 'invalid server config (id required; stdio requires command, http requires url)')
    if (cfg.id !== id) return badRequest(c, `yaml id "${cfg.id}" does not match server "${id}"`)

    await writeFileAtomic(filePath, body.yaml)
    // Config changed — drop the pooled client so the next session build
    // reconnects. Global scope affects every workspace (null = all).
    await closeMcpClient(body.scope === 'workspace' ? (body.projectId ?? null) : null, id)
    return c.json({ server: cfg })
  })

  // ── Delete ─────────────────────────────────────────────────────────
  app.delete('/mcp-servers/:id', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const dir = dirFor(c.req.query('scope'), c.req.query('projectId') || undefined)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')
    try {
      await fs.rm(path.join(dir, `${id}.yaml`))
    } catch { return notFound(c, `MCP server "${id}"`) }
    await closeMcpClient(c.req.query('scope') === 'workspace' ? (c.req.query('projectId') || null) : null, id)
    return c.json({ ok: true })
  })

  // ── Enable / disable (flips the yaml `enabled` field) ──────────────
  app.patch('/mcp-servers/:id/toggle', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const scope = c.req.query('scope')
    const dir = dirFor(scope, c.req.query('projectId') || undefined)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')
    const filePath = path.join(dir, `${id}.yaml`)
    const raw = await readServerFile(dir, id)
    if (raw === null) return notFound(c, `MCP server "${id}"`)

    // Document API keeps comments/formatting; only the enabled leaf changes.
    let doc: YAML.Document
    try {
      doc = YAML.parseDocument(raw)
    } catch (err) {
      return badRequest(c, `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`)
    }
    const next = doc.get('enabled') === false // currently disabled → re-enable
    if (next) {
      doc.delete('enabled') // true is the default — drop the key entirely
    } else {
      doc.set('enabled', false)
    }
    await writeFileAtomic(filePath, doc.toString())
    await closeMcpClient(scope === 'workspace' ? (c.req.query('projectId') || null) : null, id)
    return c.json({ ok: true, enabled: next })
  })

  // ── Probe (test connection, unpooled) ──────────────────────────────
  app.post('/mcp-servers/:id/probe', async (c) => {
    const id = c.req.param('id')
    if (!isSafeIdSegment(id)) return badRequest(c, `invalid id "${id}"`)
    const body = await c.req.json<{ scope?: string; projectId?: string }>().catch(() => ({} as { scope?: string; projectId?: string }))
    const dir = dirFor(body.scope, body.projectId)
    if (!dir) return badRequest(c, 'projectId required for workspace scope')
    const raw = await readServerFile(dir, id)
    if (raw === null) return notFound(c, `MCP server "${id}"`)
    const cfg = parseMcpServerConfig(YAML.parse(raw), `POST /mcp-servers/${id}/probe`)
    if (!cfg) return badRequest(c, 'invalid server config (stdio requires command, http requires url)')
    const result = await probeMcpServer(body.projectId ?? '', cfg)
    return c.json(result)
  })

  return app
}
