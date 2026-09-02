import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMcpRoutes } from '../src/routes/mcp.js'
import { closeAllMcpClients } from '../src/tools/mcp-tools.js'

/**
 * Route-level coverage for the MCP management API (routes/mcp.ts). The
 * Hono app is driven directly via app.request() (route-id-guards pattern);
 * `createMcpRoutes(globalDirOverride)` points the global scope at a tmpdir
 * so tests never touch the real ~/.halo. Probe tests reuse the hand-rolled
 * fake stdio MCP server fixture from the mcp-tools suite.
 */

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

let ws: string
let globalDir: string
let app: ReturnType<typeof createMcpRoutes>

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-mcp-route-ws-'))
  globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-mcp-route-global-'))
  app = createMcpRoutes(globalDir)
})

afterEach(async () => {
  await closeAllMcpClients()
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(globalDir, { recursive: true, force: true })
})

const json = (body: unknown) => ({ 'Content-Type': 'application/json', body: JSON.stringify(body) })
const wsQuery = () => `scope=workspace&projectId=${encodeURIComponent(ws)}`

function writeGlobal(id: string, lines: string[]): void {
  fs.writeFileSync(path.join(globalDir, `${id}.yaml`), lines.join('\n'))
}

describe('POST /mcp-servers — create', () => {
  it('creates a stdio server in global scope and lists it', async () => {
    const res = await app.request('/mcp-servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...json({ id: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], description: 'GitHub tools' }),
    })
    expect(res.status).toBe(201)
    const file = fs.readFileSync(path.join(globalDir, 'github.yaml'), 'utf-8')
    expect(file).toContain('id: github')
    expect(file).toContain('command: npx')

    const list = await (await app.request('/mcp-servers')).json()
    expect(list.servers).toHaveLength(1)
    expect(list.servers[0]).toMatchObject({ id: 'github', transport: 'stdio', scope: 'global', enabled: true })
  })

  it('409 on same-scope duplicate; reports (not blocks) cross-scope shadow', async () => {
    writeGlobal('dup', ['id: dup', 'transport: stdio', 'command: x'])
    const same = await app.request('/mcp-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...json({ id: 'dup', transport: 'stdio', command: 'y' }) })
    expect(same.status).toBe(409)

    const cross = await app.request('/mcp-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...json({ id: 'dup', transport: 'stdio', command: 'y', scope: 'workspace', projectId: ws }) })
    expect(cross.status).toBe(201)
    const body = await cross.json()
    expect(body.conflictScope).toBe('global')
    expect(fs.existsSync(path.join(ws, '.halo', 'mcp', 'dup.yaml'))).toBe(true)
  })

  it('rejects traversal ids, missing url/command, and workspace scope without projectId', async () => {
    const traversal = await app.request('/mcp-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...json({ id: '../../evil', transport: 'stdio', command: 'x' }) })
    expect(traversal.status).toBe(400)

    const noUrl = await app.request('/mcp-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...json({ id: 'h', transport: 'http' }) })
    expect(noUrl.status).toBe(400)

    const noProject = await app.request('/mcp-servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, ...json({ id: 'w', transport: 'stdio', command: 'x', scope: 'workspace' }) })
    expect(noProject.status).toBe(400)
  })
})

describe('GET /mcp-servers — list', () => {
  it('marks global entries overridden by a same-id workspace file', async () => {
    writeGlobal('shared', ['id: shared', 'transport: stdio', 'command: global-cmd'])
    writeGlobal('only-global', ['id: only-global', 'transport: http', 'url: https://x.example/mcp', 'enabled: false'])
    fs.mkdirSync(path.join(ws, '.halo', 'mcp'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.halo', 'mcp', 'shared.yaml'), 'id: shared\ntransport: stdio\ncommand: ws-cmd')

    const res = await app.request(`/mcp-servers?projectId=${encodeURIComponent(ws)}`)
    const { servers } = await res.json()
    const shared = servers.find((s: { id: string }) => s.id === 'shared' && s.scope === 'global')
    expect(shared.overridden).toBe(true)
    const wsShared = servers.find((s: { id: string }) => s.id === 'shared' && s.scope === 'workspace')
    expect(wsShared).toBeDefined()
    // disabled servers stay in the management list (loadMcpServers would filter them)
    expect(servers.find((s: { id: string }) => s.id === 'only-global').enabled).toBe(false)
  })
})

describe('GET/PUT /mcp-servers/:id/yaml — raw round-trip', () => {
  it('reads raw yaml and writes it back verbatim (comments survive)', async () => {
    writeGlobal('srv', ['# top comment', 'id: srv', 'transport: stdio', 'command: old-cmd'])
    const get = await app.request('/mcp-servers/srv/yaml')
    const { yaml } = await get.json()
    expect(yaml).toContain('# top comment')

    const next = yaml.replace('command: old-cmd', 'command: new-cmd')
    const put = await app.request('/mcp-servers/srv/yaml', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, ...json({ yaml: next }) })
    expect(put.status).toBe(200)
    expect(fs.readFileSync(path.join(globalDir, 'srv.yaml'), 'utf-8')).toBe(next)
  })

  it('rejects id mismatch, invalid yaml, and unknown server', async () => {
    writeGlobal('srv', ['id: srv', 'transport: stdio', 'command: x'])
    const mismatch = await app.request('/mcp-servers/srv/yaml', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, ...json({ yaml: 'id: other\ntransport: stdio\ncommand: x' }) })
    expect(mismatch.status).toBe(400)

    const broken = await app.request('/mcp-servers/srv/yaml', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, ...json({ yaml: 'id: [unclosed' }) })
    expect(broken.status).toBe(400)

    const missing = await app.request('/mcp-servers/ghost/yaml')
    expect(missing.status).toBe(404)
  })
})

describe('PATCH /mcp-servers/:id/toggle', () => {
  it('flips the enabled field and preserves comments', async () => {
    writeGlobal('srv', ['# keep me', 'id: srv', 'transport: stdio', 'command: x'])
    const off = await app.request('/mcp-servers/srv/toggle', { method: 'PATCH' })
    expect((await off.json()).enabled).toBe(false)
    let raw = fs.readFileSync(path.join(globalDir, 'srv.yaml'), 'utf-8')
    expect(raw).toContain('# keep me')
    expect(raw).toContain('enabled: false')

    const on = await app.request('/mcp-servers/srv/toggle', { method: 'PATCH' })
    expect((await on.json()).enabled).toBe(true)
    raw = fs.readFileSync(path.join(globalDir, 'srv.yaml'), 'utf-8')
    expect(raw).not.toContain('enabled') // true is the default — key dropped
  })
})

describe('DELETE /mcp-servers/:id', () => {
  it('deletes the file; 404 when missing; 400 on traversal', async () => {
    writeGlobal('doomed', ['id: doomed', 'transport: stdio', 'command: x'])
    const res = await app.request('/mcp-servers/doomed', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(globalDir, 'doomed.yaml'))).toBe(false)

    expect((await app.request('/mcp-servers/doomed', { method: 'DELETE' })).status).toBe(404)
    expect((await app.request('/mcp-servers/..%2F..%2Fetc', { method: 'DELETE' })).status).toBe(400)
  })

  it('deletes a workspace-scope server', async () => {
    fs.mkdirSync(path.join(ws, '.halo', 'mcp'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.halo', 'mcp', 'local.yaml'), 'id: local\ntransport: stdio\ncommand: x')
    const res = await app.request(`/mcp-servers/local?${wsQuery()}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(ws, '.halo', 'mcp', 'local.yaml'))).toBe(false)
  })
})

describe('POST /mcp-servers/:id/probe', () => {
  it('connects to the fake stdio server and returns its tools', async () => {
    writeGlobal('fake', [
      'id: fake',
      'transport: stdio',
      `command: ${JSON.stringify(process.execPath)}`,
      `args: [${JSON.stringify(FAKE_SERVER)}]`,
    ])
    const res = await app.request('/mcp-servers/fake/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.toolCount).toBe(3)
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['echo', 'boom', 'lookup'])
    expect(body.tools.find((t: { name: string }) => t.name === 'lookup').readOnly).toBe(true)
  }, 30000)

  it('returns ok:false for an unreachable server (never throws)', async () => {
    writeGlobal('dead', ['id: dead', 'transport: stdio', 'command: definitely-not-a-real-binary-halo-test'])
    const res = await app.request('/mcp-servers/dead/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(false)
  }, 30000)

  it('404s for an unknown server', async () => {
    expect((await app.request('/mcp-servers/ghost/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404)
  })
})
