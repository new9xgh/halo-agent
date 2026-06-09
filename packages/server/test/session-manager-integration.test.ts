import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * INTEGRATION coverage for the SessionManager → SessionUIStore / SessionQueryStore
 * carve-out. The per-store unit tests use a FAKE host, so the one thing they
 * cannot prove is the real `this`-as-host wiring: that SessionManager actually
 * passes itself, that the stores read the manager's real db / sessions map /
 * tombstone, and that disk persistence lands real files. These tests build a
 * REAL SessionManager against a tmpdir workspace (real SQLite, real disk) and
 * drive the exact methods the refactor rewired. They deliberately avoid
 * createSession (which would build a live model runtime) by seeding the db row
 * directly via getDb() — the event/query/persist paths are what changed, not
 * agent construction.
 */

let ws: string
let sm: SessionManager

/** Seed an agent_sessions row directly — bypasses createSession's model build. */
function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: over.description ?? '',
    workingDir: null,
    accessLevel: over.accessLevel ?? null,
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    stoppedAt: over.stoppedAt ?? null,
    archivedAt: over.archivedAt ?? null,
  }).run()
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-sm-int-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('emitEvent → real disk persistence (UIStore wired into the real manager)', () => {
  it('a complete event flushes the UI log to a real .json file under the workspace', () => {
    seedRow('root1', { agentId: 'default' })
    sm.appendUserMessage('root1', 'hi there')
    sm.emitEvent('root1', { type: 'complete' })

    // The session file should now exist on disk under sessions/<agentId>/.
    const dir = join(ws, '.halo', 'sessions', 'default')
    expect(existsSync(dir)).toBe(true)
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThan(0)
    const data = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'))
    expect(data.messages.some((m: { content?: string }) => m.content === 'hi there')).toBe(true)
  })

  it('ensureUIState seeds agentId from the real db row when persisting', () => {
    // No in-memory session (we never called createSession), so persistUIState's
    // db fallback for agentId is the ONLY source — the path a fake host stubs out.
    seedRow('root2', { agentId: 'researcher', agentName: 'Researcher' })
    sm.appendNotification('root2', 'system note')

    const dir = join(ws, '.halo', 'sessions', 'researcher')
    expect(existsSync(dir)).toBe(true)  // routed to the db row's agentId, not 'default'
  })
})

describe('getSessionView — prepareForView wiring (UIStore, first knife)', () => {
  it('returns a disk-backed view for a session this process is not running', async () => {
    seedRow('rootV', { agentId: 'default' })
    sm.appendUserMessage('rootV', 'persisted msg')
    sm.emitEvent('rootV', { type: 'complete' })  // flush to disk

    const view = await sm.getSessionView('rootV')
    expect(view).not.toBeNull()
    expect(view!.messages.some((m) => m.content === 'persisted msg')).toBe(true)
    expect(view!.isRunning).toBe(false)
  })

  it('returns null for a session that does not exist in the db', async () => {
    expect(await sm.getSessionView('ghost')).toBeNull()
  })
})

describe('deleteSession — purge + tombstone wiring (UIStore, first knife)', () => {
  it('purges UI state and tombstones the id so later writes are blocked', async () => {
    seedRow('rootD', { agentId: 'default' })
    sm.appendUserMessage('rootD', 'will be deleted')
    expect(sm.getCachedUIState('rootD')).not.toBeNull()

    const removed = await sm.deleteSession('rootD')
    expect(removed).toContain('rootD')
    // UI state purged…
    expect(sm.getCachedUIState('rootD')).toBeNull()
    // …and tombstoned: a racing persist for this id must be a no-op.
    expect(sm.isSessionDeleted('rootD')).toBe(true)
  })

  it('cascade-deletes descendants', async () => {
    seedRow('rootC', { agentId: 'default' })
    seedRow('rootC>child', { parentId: 'rootC', agentId: 'default' })
    const removed = await sm.deleteSession('rootC')
    expect(removed.sort()).toEqual(['rootC', 'rootC>child'])
    expect(sm.getSessionById('rootC')).toBeNull()
    expect(sm.getSessionById('rootC>child')).toBeNull()
  })
})

describe('query store wired into the real manager (second knife)', () => {
  it('getSessionById / listSessions resolve status against the real db', () => {
    seedRow('q1', { updatedAt: 100 })
    seedRow('q2', { updatedAt: 200, stoppedAt: 5000 })
    expect(sm.getSessionById('q1')?.status).toBe('idle')
    expect(sm.getSessionById('q2')?.status).toBe('stopped')

    const { sessions } = sm.listSessions({ rootOnly: true })
    expect(sessions.map((s) => s.id)).toEqual(['q2', 'q1'])  // updated_at DESC
  })

  it('findLatestByPrefix returns the newest matching root', () => {
    seedRow('wx_u_a', { createdAt: 100 })
    seedRow('wx_u_b', { createdAt: 200 })
    expect(sm.findLatestByPrefix('wx_u_')?.id).toBe('wx_u_b')
  })
})
