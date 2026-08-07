import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { agentSessions } from '../src/db/schema.js'
import {
  ARCHIVE_KEEP_EXCHANGES, archiveSplitIndex, readArchiveCount,
  writeArchiveSegment, deleteArchiveSegments,
} from '../src/sessions/session-archive.js'
import { findAndDeleteSessionFile } from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * UI-log archiving (`<seg>.arch.<N>.json.gz`). The UI half of a session file had
 * no compaction and grew without bound (measured: 6.9MB of a 7.4MB file). These
 * tests pin the four properties the design depends on:
 *
 *  1. the split lands on a main-user-exchange boundary, never mid-turn
 *  2. the active file keeps its exact shape — only `messages` shrinks and an
 *     `archiveCount` header appears, so every existing reader is unaffected
 *  3. `archiveCount` is a COMMIT MARKER: a segment written but not committed is
 *     unreachable, and re-running the archive re-derives the same N (idempotent)
 *  4. deletion is filesystem-glob driven, so uncommitted/orphan segments go too
 *
 * Real disk + real gzip throughout — the crash-consistency and glob behaviours
 * are exactly the parts a mocked fs would fake away.
 */

let ws: string
let sm: SessionManager

function uiMsg(role: 'user' | 'assistant', content: string, over: Partial<SessionMessage> = {}): SessionMessage {
  return { id: `m_${content}_${role}`, role, type: role, content, timestamp: 1000, ...over }
}

/** `n` main exchanges: user + assistant each. */
function exchanges(n: number, from = 0): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = from; i < from + n; i++) {
    out.push(uiMsg('user', `u${i}`), uiMsg('assistant', `a${i}`))
  }
  return out
}

function sessionDir(agentId = 'default'): string {
  return join(ws, '.halo', 'sessions', agentId)
}

function seedRow(id: string, over: Partial<typeof agentSessions.$inferInsert> = {}): void {
  sm.getDb().insert(agentSessions).values({
    id,
    parentId: over.parentId ?? null,
    agentId: over.agentId ?? 'default',
    agentName: over.agentName ?? 'Default',
    description: '',
    workingDir: null,
    accessLevel: null,
    createdAt: 1000,
    updatedAt: 1000,
    stoppedAt: null,
    archivedAt: null,
  }).run()
}

/** Seed a cold session .json in the same shape saveSessionToFile writes. */
function seedFile(id: string, messages: SessionMessage[], extra: Record<string, unknown> = {}, agentId = 'default'): string {
  const dir = sessionDir(agentId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, `${id}.json`)
  writeFileSync(filePath, JSON.stringify({
    version: 1, id, agentId, agentName: 'Default', title: 'seeded', source: 'explorer',
    createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(),
    messageCount: messages.length, contextTokens: 111, totalOutputTokens: 222,
    messages, rawMessages: [{ role: 'user', content: 'raw' }], ...extra,
  }, null, 2))
  return filePath
}

function readActive(id: string, agentId = 'default'): Record<string, unknown> & { messages: SessionMessage[] } {
  return JSON.parse(readFileSync(join(sessionDir(agentId), `${id}.json`), 'utf-8'))
}

function readSegment(id: string, n: number, agentId = 'default'): SessionMessage[] {
  return JSON.parse(gunzipSync(readFileSync(join(sessionDir(agentId), `${id}.arch.${n}.json.gz`))).toString('utf-8'))
}

function segmentNames(agentId = 'default'): string[] {
  return readdirSync(sessionDir(agentId)).filter((f) => f.includes('.arch.')).sort()
}

/** The store, reached through the manager that owns it (same wiring prod uses). */
function uiStore(): { archiveOldMessages: (id: string) => number } {
  return (sm as unknown as { uiStore: { archiveOldMessages: (id: string) => number } }).uiStore
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-ui-arch-'))
  sm = new SessionManager(ws)
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('archiveSplitIndex — where the log is cut', () => {
  it('returns 0 while the log holds at most the keep count', () => {
    expect(archiveSplitIndex(exchanges(ARCHIVE_KEEP_EXCHANGES))).toBe(0)
    expect(archiveSplitIndex([])).toBe(0)
  })

  it('cuts so exactly the last keep-count exchanges remain', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 3)
    const cut = archiveSplitIndex(log)
    // 3 extra exchanges × 2 messages each move out.
    expect(cut).toBe(6)
    expect(log.slice(cut).filter((m) => m.role === 'user')).toHaveLength(ARCHIVE_KEEP_EXCHANGES)
  })

  it('always cuts at the START of a main user exchange', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 5)
    const cut = archiveSplitIndex(log)
    expect(log[cut].role).toBe('user')
    expect(log[cut].taskId).toBeUndefined()
  })

  it('ignores sub-agent (taskId) user messages when counting exchanges', () => {
    // Sub-agent turns are not main exchanges; a log made only of them plus a few
    // main ones must not be cut on a taskId row.
    const log: SessionMessage[] = []
    for (let i = 0; i < ARCHIVE_KEEP_EXCHANGES + 2; i++) {
      log.push(uiMsg('user', `u${i}`))
      log.push(uiMsg('user', `sub${i}`, { taskId: 'root>child' }))
      log.push(uiMsg('assistant', `a${i}`))
    }
    const cut = archiveSplitIndex(log)
    expect(log[cut].taskId).toBeUndefined()
    expect(log.slice(cut).filter((m) => m.role === 'user' && !m.taskId)).toHaveLength(ARCHIVE_KEEP_EXCHANGES)
  })

  it('keeps the in-flight turn out of the archive (its user msg is the newest)', () => {
    // A mid-turn compact: last user message has no assistant reply yet.
    const log = [...exchanges(ARCHIVE_KEEP_EXCHANGES + 4), uiMsg('user', 'in-flight')]
    const cut = archiveSplitIndex(log)
    const kept = log.slice(cut)
    expect(kept.at(-1)?.content).toBe('in-flight')
    // and the archived part never contains it
    expect(log.slice(0, cut).some((m) => m.content === 'in-flight')).toBe(false)
  })
})

describe('archiveOldMessages — segment write + active-file slim down', () => {
  it('moves older messages into segment 1 and keeps the tail in place', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 4)
    seedRow('r1')
    seedFile('r1', log)

    const moved = uiStore().archiveOldMessages('r1')

    expect(moved).toBe(8)                     // 4 extra exchanges × 2
    expect(segmentNames()).toEqual(['r1.arch.1.json.gz'])
    expect(readSegment('r1', 1).map((m) => m.content)).toEqual(log.slice(0, 8).map((m) => m.content))

    const active = readActive('r1')
    expect(active.messages.map((m) => m.content)).toEqual(log.slice(8).map((m) => m.content))
    expect(active.archiveCount).toBe(1)
  })

  it('segment + active file together still hold every message, in order', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 6)
    seedRow('r1')
    seedFile('r1', log)

    uiStore().archiveOldMessages('r1')

    const rejoined = [...readSegment('r1', 1), ...readActive('r1').messages]
    expect(rejoined.map((m) => m.content)).toEqual(log.map((m) => m.content))
  })

  it('leaves the active file shape untouched apart from messages + archiveCount', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 2)
    seedRow('r1')
    const before = JSON.parse(readFileSync(seedFile('r1', log), 'utf-8'))

    uiStore().archiveOldMessages('r1')
    const after = readActive('r1')

    // Every pre-existing key survives (no field dropped, none renamed).
    for (const key of Object.keys(before)) expect(after).toHaveProperty(key)
    // Only these three legitimately differ: the log shrank, its count follows,
    // and updatedAt is refreshed by the write.
    expect(after.rawMessages).toEqual(before.rawMessages)
    expect(after.contextTokens).toBe(before.contextTokens)
    expect(after.totalOutputTokens).toBe(before.totalOutputTokens)
    expect(after.title).toBe(before.title)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.id).toBe(before.id)
    expect(after.messageCount).toBe(after.messages.length)
  })

  it('is a no-op when the log is short enough (no segment, no header)', () => {
    seedRow('r1')
    seedFile('r1', exchanges(3))

    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(segmentNames()).toEqual([])
    expect(readActive('r1').archiveCount).toBeUndefined()
  })

  it('increments N across successive archives, older segment untouched', () => {
    seedRow('r1')
    seedFile('r1', exchanges(ARCHIVE_KEEP_EXCHANGES + 2))
    uiStore().archiveOldMessages('r1')
    const firstSegment = readSegment('r1', 1)

    // Session keeps chatting: append more exchanges to the (already slimmed)
    // active log through the same in-memory state, then archive again.
    const state = sm.getUIState('r1')!
    state.messageLog = [...state.messageLog, ...exchanges(5, 100)]
    const moved = uiStore().archiveOldMessages('r1')

    expect(moved).toBe(10)
    expect(segmentNames()).toEqual(['r1.arch.1.json.gz', 'r1.arch.2.json.gz'])
    expect(readSegment('r1', 1)).toEqual(firstSegment)   // read-only forever
    expect(readActive('r1').archiveCount).toBe(2)
  })

  it('skips a tombstoned session (no segment written)', () => {
    seedRow('r1')
    seedFile('r1', exchanges(ARCHIVE_KEEP_EXCHANGES + 2))
    vi.spyOn(sm, 'isSessionDeleted').mockReturnValue(true)

    expect(uiStore().archiveOldMessages('r1')).toBe(0)
    expect(segmentNames()).toEqual([])
  })
})

describe('archiveCount as commit marker — crash safety', () => {
  it('an uncommitted segment is invisible and gets overwritten by the retry', () => {
    // Simulate a crash between step 1 (segment written) and step 2 (commit):
    // segment 1 exists on disk, the active file has no archiveCount and still
    // holds the complete log.
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 4)
    seedRow('r1')
    seedFile('r1', log)
    mkdirSync(sessionDir(), { recursive: true })
    writeArchiveSegment(sessionDir(), 'r1', 1, [uiMsg('user', 'stale-orphan')])

    // Nothing committed → readers see count 0, so the orphan is unreachable.
    expect(readArchiveCount(sessionDir(), 'r1')).toBe(0)

    // The retry derives the SAME N=1 and overwrites the orphan in place.
    const moved = uiStore().archiveOldMessages('r1')

    expect(moved).toBe(8)
    expect(segmentNames()).toEqual(['r1.arch.1.json.gz'])
    expect(readSegment('r1', 1).some((m) => m.content === 'stale-orphan')).toBe(false)
    expect(readArchiveCount(sessionDir(), 'r1')).toBe(1)
    // Zero loss: everything is still reachable across segment + active file.
    expect([...readSegment('r1', 1), ...readActive('r1').messages].map((m) => m.content))
      .toEqual(log.map((m) => m.content))
  })

  it('rolls the in-memory log back when the commit write does not land', () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 4)
    seedRow('r1')
    seedFile('r1', log)
    // persistSessionFile swallows IO errors in prod; emulate a failed commit.
    vi.spyOn(sm, 'persistSessionFile').mockImplementation(() => {})

    const moved = uiStore().archiveOldMessages('r1')

    // Reported as "nothing archived" and memory still holds the full log, so the
    // next ordinary persist can't write a truncated log under the old count.
    expect(moved).toBe(0)
    expect(readArchiveCount(sessionDir(), 'r1')).toBe(0)
    expect(sm.getUIState('r1')!.messageLog.map((m) => m.content)).toEqual(log.map((m) => m.content))
  })

  it('ordinary persists preserve an existing archiveCount', () => {
    seedRow('r1')
    seedFile('r1', exchanges(ARCHIVE_KEEP_EXCHANGES + 2))
    uiStore().archiveOldMessages('r1')
    expect(readActive('r1').archiveCount).toBe(1)

    // A plain UI write (no archiveCount argument) must carry the marker forward —
    // dropping it would orphan segment 1.
    sm.appendNotification('r1', 'context compacted')
    expect(readActive('r1').archiveCount).toBe(1)
  })
})

describe('deletion — filesystem glob, not header state', () => {
  it('deleteArchiveSegments removes committed AND uncommitted segments', async () => {
    mkdirSync(sessionDir(), { recursive: true })
    writeArchiveSegment(sessionDir(), 'r1', 1, exchanges(1))
    writeArchiveSegment(sessionDir(), 'r1', 2, exchanges(1))
    writeArchiveSegment(sessionDir(), 'r1', 3, exchanges(1))   // uncommitted orphan
    seedFile('r1', exchanges(1), { archiveCount: 2 })

    await deleteArchiveSegments(sessionDir(), 'r1')

    expect(segmentNames()).toEqual([])
  })

  it('only touches the target session\'s segments', async () => {
    mkdirSync(sessionDir(), { recursive: true })
    writeArchiveSegment(sessionDir(), 'r1', 1, exchanges(1))
    writeArchiveSegment(sessionDir(), 'other', 1, exchanges(1))

    await deleteArchiveSegments(sessionDir(), 'r1')

    expect(segmentNames()).toEqual(['other.arch.1.json.gz'])
  })

  it('findAndDeleteSessionFile (the DELETE /api route) clears segments too', async () => {
    seedRow('r1')
    seedFile('r1', exchanges(ARCHIVE_KEEP_EXCHANGES + 2))
    uiStore().archiveOldMessages('r1')
    expect(segmentNames()).toHaveLength(1)

    await findAndDeleteSessionFile('r1', ws)

    expect(existsSync(join(sessionDir(), 'r1.json'))).toBe(false)
    expect(segmentNames()).toEqual([])
  })
})

describe('deleteExchange refuses once history is archived', () => {
  it('returns archived and leaves both streams untouched', async () => {
    const log = exchanges(ARCHIVE_KEEP_EXCHANGES + 2)
    seedRow('r1')
    seedFile('r1', log)
    uiStore().archiveOldMessages('r1')
    const before = readActive('r1')

    // Ordinal 0 would point at a different turn on each side of the archive —
    // refuse rather than delete the wrong one.
    expect(await sm.deleteExchange('r1', 0)).toBe('archived')

    const after = readActive('r1')
    expect(after.messages.some((m) => m.deleted)).toBe(false)
    expect(after.messages).toEqual(before.messages)
    expect(after.rawMessages).toEqual(before.rawMessages)
  })

  it('still deletes normally when nothing has been archived', async () => {
    seedRow('r1')
    seedFile('r1', exchanges(2))
    expect(await sm.deleteExchange('r1', 0)).toBe('deleted')
  })

  it('reads the marker from disk, not memory', async () => {
    // No in-memory UI state at all (fresh manager over the same workspace, so the
    // db row persists) — the guard must still fire off the on-disk header.
    seedRow('r1')
    seedFile('r1', exchanges(3), { archiveCount: 2 })
    sm = new SessionManager(ws)

    expect(await sm.deleteExchange('r1', 0)).toBe('archived')
  })
})
