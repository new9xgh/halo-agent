import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMcpServers } from '../src/config.js'
import { createMcpTools, closeAllMcpClients } from '../src/tools/mcp-tools.js'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Coverage for the MCP client feature:
 *   1. loadMcpServers — yaml registry loading (global + workspace overlay,
 *      <<ENV>> expansion, invalid-file skipping, enabled filter)
 *   2. createMcpTools — stdio connect → tools/list → ToolDef conversion and
 *      callTool result mapping, driven against a hand-rolled fake MCP server
 *      (test/fixtures/fake-mcp-server.mjs) so the real protocol round-trip
 *      is exercised offline
 *   3. SessionAgentBuilder integration — MCP tools land in meta.toolNames,
 *      bypass the yaml `tools:` whitelist, and readonly sessions keep only
 *      readOnlyHint-annotated tools
 */

const FAKE_SERVER = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

let ws: string
const managers: SessionManager[] = []

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-mcp-'))
})

afterEach(async () => {
  // Kill pooled stdio children so vitest can exit.
  await closeAllMcpClients()
  // Release the better-sqlite3 file handle before rmSync — Windows won't
  // unlink an open halo.db (EBUSY). No-op on platforms that allow it.
  for (const sm of managers.splice(0)) {
    try { sm.getDb().$client.close() } catch { /* already closed */ }
  }
  rmSync(ws, { recursive: true, force: true })
})

/** Write a fake-server declaration into the given mcp dir. */
function declareFakeServer(mcpDir: string, extraLines: string[] = []): void {
  mkdirSync(mcpDir, { recursive: true })
  const yaml = [
    'id: fake',
    'transport: stdio',
    `command: ${JSON.stringify(process.execPath)}`,
    `args: [${JSON.stringify(FAKE_SERVER)}]`,
    ...extraLines,
  ].join('\n')
  writeFileSync(join(mcpDir, 'fake.yaml'), yaml)
}

describe('loadMcpServers — registry loading', () => {
  it('loads a stdio server and expands <<ENV>> in env values', () => {
    process.env.HALO_TEST_MCP_TOKEN = 'secret123'
    try {
      const dir = join(ws, 'global-mcp')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'srv.yaml'), [
        'id: srv',
        'transport: stdio',
        'command: npx',
        'args: ["-y", "some-server"]',
        'env: { TOKEN: "<<HALO_TEST_MCP_TOKEN>>" }',
      ].join('\n'))

      const servers = loadMcpServers(ws, dir)
      expect(servers).toHaveLength(1)
      expect(servers[0].id).toBe('srv')
      expect(servers[0].transport).toBe('stdio')
      expect(servers[0].command).toBe('npx')
      expect(servers[0].args).toEqual(['-y', 'some-server'])
      expect(servers[0].env?.TOKEN).toBe('secret123')
    } finally {
      delete process.env.HALO_TEST_MCP_TOKEN
    }
  })

  it('workspace file overrides the global file with the same name', () => {
    const globalDir = join(ws, 'global-mcp')
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(join(globalDir, 'srv.yaml'), 'id: srv\ntransport: stdio\ncommand: global-cmd')
    mkdirSync(join(ws, '.halo', 'mcp'), { recursive: true })
    writeFileSync(join(ws, '.halo', 'mcp', 'srv.yaml'), 'id: srv\ntransport: stdio\ncommand: ws-cmd')

    const servers = loadMcpServers(ws, globalDir)
    expect(servers).toHaveLength(1)
    expect(servers[0].command).toBe('ws-cmd')
  })

  it('skips invalid files and filters out disabled servers', () => {
    const dir = join(ws, 'global-mcp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'no-id.yaml'), 'transport: stdio\ncommand: x')
    writeFileSync(join(dir, 'stdio-no-cmd.yaml'), 'id: a\ntransport: stdio')
    writeFileSync(join(dir, 'http-no-url.yaml'), 'id: b\ntransport: http')
    writeFileSync(join(dir, 'disabled.yaml'), 'id: c\ntransport: stdio\ncommand: x\nenabled: false')
    writeFileSync(join(dir, 'ok.yaml'), 'id: ok\ntransport: http\nurl: https://mcp.example.com/mcp\nheaders: { Authorization: "Bearer <<HALO_TEST_UNSET>>" }')

    const servers = loadMcpServers(ws, dir)
    expect(servers.map((s) => s.id)).toEqual(['ok'])
    // unset env var keeps the literal placeholder (expandEnv contract)
    expect(servers[0].headers?.Authorization).toBe('Bearer <<HALO_TEST_UNSET>>')
  })

  it('returns an empty list when no mcp dirs exist', () => {
    expect(loadMcpServers(ws, join(ws, 'nonexistent'))).toEqual([])
  })
})

describe('createMcpTools — stdio round-trip against the fake server', () => {
  it('lists tools as mcp__-prefixed ToolDefs and calls them', async () => {
    declareFakeServer(join(ws, '.halo', 'mcp'))
    const servers = loadMcpServers(ws, join(ws, 'no-global'))
    const { tools, readOnlyNames } = await createMcpTools(ws, servers)

    const names = tools.map((t) => t.name)
    expect(names).toContain('mcp__fake__echo')
    expect(names).toContain('mcp__fake__boom')
    expect(names).toContain('mcp__fake__lookup')
    expect(readOnlyNames.has('mcp__fake__lookup')).toBe(true)
    expect(readOnlyNames.has('mcp__fake__echo')).toBe(false)

    const echo = tools.find((t) => t.name === 'mcp__fake__echo')!
    expect(echo.description).toContain('[fake]')
    expect(echo.inputSchema).toMatchObject({ type: 'object', required: ['text'] })
    expect(await echo.callback({ text: 'hi' })).toBe('echo:hi')

    const lookup = tools.find((t) => t.name === 'mcp__fake__lookup')!
    expect(await lookup.callback({})).toBe('found')
  }, 30000)

  it('maps isError results and call failures to the TOOL_ERROR marker', async () => {
    declareFakeServer(join(ws, '.halo', 'mcp'))
    const servers = loadMcpServers(ws, join(ws, 'no-global'))
    const { tools } = await createMcpTools(ws, servers)

    const boom = tools.find((t) => t.name === 'mcp__fake__boom')!
    const result = await boom.callback({})
    expect(typeof result).toBe('string')
    expect(result as string).toMatch(/^__TOOL_ERROR__\n/)
    expect(result as string).toContain('kaboom')
  }, 30000)

  it('skips an unreachable server without failing the whole set', async () => {
    const dir = join(ws, '.halo', 'mcp')
    declareFakeServer(dir)
    writeFileSync(join(dir, 'dead.yaml'), 'id: dead\ntransport: stdio\ncommand: definitely-not-a-real-binary-halo-test')
    const servers = loadMcpServers(ws, join(ws, 'no-global'))
    const { tools } = await createMcpTools(ws, servers)
    expect(tools.map((t) => t.name)).toContain('mcp__fake__echo')
    expect(tools.some((t) => t.name.startsWith('mcp__dead__'))).toBe(false)
  }, 30000)
})

describe('SessionAgentBuilder — MCP tools in the assembled tool set', () => {
  const ANTHROPIC_MODEL = [
    'model:',
    '  provider: anthropic',
    '  id: claude-opus-4-8',
    '  endpoint: https://api.anthropic.com',
  ]

  function writeAgent(agentId: string, yamlLines: string[]): void {
    const dir = join(ws, '.halo', 'agents', agentId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'agent.yaml'), yamlLines.join('\n'))
  }

  function seedSession(sm: SessionManager, id: string, agentId: string, accessLevel: string | null = null): void {
    sm.getDb().insert(agentSessions).values({
      id, parentId: null, agentId, agentName: agentId,
      description: '', workingDir: null, accessLevel,
      createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
    }).run()
  }

  it('MCP tools bypass the yaml tools: whitelist and land in meta.toolNames', async () => {
    declareFakeServer(join(ws, '.halo', 'mcp'))
    writeAgent('mcpagent', ['name: M', ...ANTHROPIC_MODEL, 'tools: [file_read]'])
    const sm = new SessionManager(ws)
    managers.push(sm)
    seedSession(sm, 's_mcp', 'mcpagent')

    const ctx = await sm.getSessionContext('s_mcp')
    expect(ctx?.meta.toolNames).toContain('file_read')
    expect(ctx?.meta.toolNames).not.toContain('file_write') // whitelist still applies to workspace tools
    expect(ctx?.meta.toolNames).toContain('mcp__fake__echo')
    expect(ctx?.meta.toolNames).toContain('mcp__fake__lookup')
  }, 30000)

  it('readonly sessions keep only readOnlyHint-annotated MCP tools', async () => {
    declareFakeServer(join(ws, '.halo', 'mcp'))
    writeAgent('roagent', ['name: R', ...ANTHROPIC_MODEL, 'tools: [file_read]'])
    const sm = new SessionManager(ws)
    managers.push(sm)
    seedSession(sm, 's_ro', 'roagent', 'readonly')

    const ctx = await sm.getSessionContext('s_ro')
    expect(ctx?.meta.toolNames).toContain('mcp__fake__lookup')
    expect(ctx?.meta.toolNames).not.toContain('mcp__fake__echo')
    expect(ctx?.meta.toolNames).not.toContain('mcp__fake__boom')
  }, 30000)
})
