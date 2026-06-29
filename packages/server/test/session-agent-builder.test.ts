import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * INTEGRATION coverage for SessionAgentBuilder, the agent-construction pipeline
 * carved out of SessionManager (third knife). The pipeline loads agent.yaml,
 * filters tools, composes the system prompt, and builds a ModelRuntime — too
 * coupled to mock usefully, so these drive a REAL SessionManager against a
 * tmpdir workspace with a self-contained agent.yaml. The chosen provider
 * ('anthropic') is a known createModelRuntime case whose constructor does NOT
 * hit the network (only .run() would), so the whole build runs offline.
 *
 * The build is triggered via getSessionContext (→ ensureSession →
 * buildAgentInstance), which surfaces exactly the BuiltAgent-derived data the
 * carve-out is responsible for: modelId, the /context tool + md-file metadata.
 */

let ws: string

/** Write a self-contained workspace agent.yaml (+ optional AGENT.md). */
function writeAgent(agentId: string, yamlLines: string[], agentMd?: string): void {
  const dir = join(ws, '.halo', 'agents', agentId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.yaml'), yamlLines.join('\n'))
  if (agentMd !== undefined) writeFileSync(join(dir, 'AGENT.md'), agentMd)
}

function seedSession(sm: SessionManager, id: string, agentId: string, parentId: string | null = null, workingDir: string | null = null): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId, agentId, agentName: agentId,
    description: '', workingDir, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

const ANTHROPIC_MODEL = [
  'model:',
  '  provider: anthropic',
  '  id: claude-opus-4-8',
  '  endpoint: https://api.anthropic.com',
]

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-builder-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('buildAgentInstance — model config + tool whitelist', () => {
  it('resolves modelId and filters tools to the yaml whitelist', async () => {
    writeAgent('tester', ['name: Tester', ...ANTHROPIC_MODEL, 'tools: [file_read, grep]'], 'test agent')
    const sm = new SessionManager(ws)
    seedSession(sm, 's1', 'tester')

    const ctx = await sm.getSessionContext('s1')
    expect(ctx?.modelId).toBe('claude-opus-4-8')
    // whitelist honoured: declared tools present, undeclared ones absent
    expect(ctx?.meta.toolNames).toContain('file_read')
    expect(ctx?.meta.toolNames).toContain('grep')
    expect(ctx?.meta.toolNames).not.toContain('file_write')
    expect(ctx?.meta.toolNames).not.toContain('shell_exec')
  })

  it('throws (→ getSessionContext returns null) when the model triple is incomplete', async () => {
    // missing model.endpoint → validateAgentModelConfig throws; ensureSession's
    // try/catch in getSessionContext converts that to null.
    writeAgent('broken', ['name: Broken', 'model:', '  provider: anthropic', '  id: claude-opus-4-8'])
    const sm = new SessionManager(ws)
    seedSession(sm, 's_broken', 'broken')
    expect(await sm.getSessionContext('s_broken')).toBeNull()
  })

  it('includes the draft tool only when whitelisted', async () => {
    writeAgent('drafter', ['name: Drafter', ...ANTHROPIC_MODEL, 'tools: [file_read, draft]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_draft', 'drafter')
    const ctx = await sm.getSessionContext('s_draft')
    expect(ctx?.meta.toolNames).toContain('draft')
  })
})

describe('composeSystemPrompt — root vs sub-agent vs metadata', () => {
  it('a root agent surfaces its AGENT.md in /context md-files', async () => {
    writeAgent('rooty', ['name: Rooty', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am rooty.')
    const sm = new SessionManager(ws)
    seedSession(sm, 'root1', 'rooty', null)  // parentId null → root
    const ctx = await sm.getSessionContext('root1')
    const labels = ctx?.meta.mdFiles.map((f) => f.label) ?? []
    expect(labels).toContain('AGENT.md')
  })

  it('skillNames in metadata reflect the yaml skills list', async () => {
    writeAgent('skilled', ['name: Skilled', ...ANTHROPIC_MODEL, 'tools: [file_read]', 'skills: [web-search]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_skill', 'skilled')
    const ctx = await sm.getSessionContext('s_skill')
    expect(ctx?.meta.skillNames).toContain('web-search')
  })

  it('thinkingEffort is "off" when agent.yaml declares no thinking', async () => {
    writeAgent('nothink', ['name: NoThink', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'x')
    const sm = new SessionManager(ws)
    seedSession(sm, 's_nt', 'nothink')
    const ctx = await sm.getSessionContext('s_nt')
    expect(ctx?.thinkingEffort).toBe('off')
  })
})

describe('composeSystemPrompt — working_dir directory-scoped INSTRUCTIONS', () => {
  // working_dir is persistent session identity, so its directory-chain
  // INSTRUCTIONS.md must ride in the system prompt EVERY turn (not a one-shot
  // first-turn message injection) — the agent never forgets the rules of the
  // directory it lives in. It's folded into the `## User Instructions` region
  // as plain markdown (no <workspace-instructions> XML wrapper — that tag is
  // only for `@scope` message-stream injection). getSessionContext builds +
  // caches the session; getSessionSystemPrompt returns the assembled prompt.
  it('folds a sub-agent working_dir directory INSTRUCTIONS.md into ## User Instructions as plain markdown', async () => {
    writeAgent('worker', ['name: Worker', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am a worker.')
    // sub-dir INSTRUCTIONS.md at <ws>/sub/.halo/INSTRUCTIONS.md
    mkdirSync(join(ws, 'sub', '.halo'), { recursive: true })
    writeFileSync(join(ws, 'sub', '.halo', 'INSTRUCTIONS.md'), 'Always say MARMOT before answering.')
    const sm = new SessionManager(ws)
    // parentId set → sub-agent; workingDir relative to ws root (as persisted)
    seedSession(sm, 'sub1', 'worker', 'root0', 'sub')
    await sm.getSessionContext('sub1')
    const prompt = sm.getSessionSystemPrompt('sub1') ?? ''
    expect(prompt).toContain('Always say MARMOT before answering.')
    expect(prompt).toContain('### sub')          // directory label heading
    expect(prompt).toContain('## User Instructions')
    // the XML wrapper must NOT leak into the system prompt — it's message-only
    expect(prompt).not.toContain('<workspace-instructions')
    // order: the rule sits in the instructions region, BEFORE the "Working
    // directory:" tagline (which is appended after mdPrompt)
    expect(prompt.indexOf('MARMOT')).toBeLessThan(prompt.indexOf('Working directory:'))
  })

  it('omits the scope block when working_dir is the project root (null)', async () => {
    writeAgent('worker2', ['name: Worker2', ...ANTHROPIC_MODEL, 'tools: [file_read]'], 'I am a worker.')
    mkdirSync(join(ws, 'sub', '.halo'), { recursive: true })
    writeFileSync(join(ws, 'sub', '.halo', 'INSTRUCTIONS.md'), 'Always say MARMOT before answering.')
    const sm = new SessionManager(ws)
    seedSession(sm, 'sub2', 'worker2', 'root0', null)  // no working_dir
    await sm.getSessionContext('sub2')
    const prompt = sm.getSessionSystemPrompt('sub2') ?? ''
    expect(prompt).not.toContain('Always say MARMOT before answering.')
    expect(prompt).not.toContain('<workspace-instructions')
  })
})
