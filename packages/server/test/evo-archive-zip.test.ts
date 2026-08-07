import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import JSZip from 'jszip'
import { createEvoDb, setEvoDb, evolutionRuns, evolutionApplies, type EvoDb } from '../src/db/evo-db.js'
import { runArchivePass } from '../src/evolution/archive.js'

/**
 * Contract (B-M7): the evolution archive job must produce its zips in pure
 * JS — the old `spawnSync('zip', …)` depended on a system binary Windows
 * doesn't ship, so archiving failed there forever and artifacts grew
 * unbounded. What the pass must guarantee:
 *
 *   - a terminal run/apply past the 14-day window is zipped to
 *     `.halo/evo/archive/{run|apply}-<id>.zip`, the live dir is deleted,
 *     and `archived_at` is stamped
 *   - the zip is complete and correct: nested files byte-identical
 *     (binary + unicode names included), empty dirs preserved, file
 *     symlinks stored as their target's content, broken/dir symlinks
 *     skipped without recursion (no cycle hang) and without failing
 *   - the output is real interoperable zip format (system `unzip -t`
 *     passes where the binary exists — dev boxes / Linux CI)
 *   - the pass stays idempotent (second call archives nothing)
 */

const DAY_MS = 24 * 60 * 60 * 1000

let tmpDir: string       // fake workspace
let tmpGlobal: string    // evo.db home
let db: EvoDb

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-archive-ws-'))
  tmpGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-evo-archive-db-'))
  db = createEvoDb(tmpGlobal)
  setEvoDb(db)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(tmpGlobal, { recursive: true, force: true })
})

/** All byte values — catches any text-mode/encoding corruption. */
const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i))

/** Build a run-artifact dir exercising every entry shape zipDir handles. */
function buildRunDir(runId: string): string {
  const dir = path.join(tmpDir, '.halo', 'evo', 'runs', runId)
  fs.mkdirSync(path.join(dir, 'sandbox', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'empty-dir'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'patch.md'), '# patch\nhello evo\n')
  fs.writeFileSync(path.join(dir, 'sandbox', 'nested', 'deep.txt'), 'deep content')
  fs.writeFileSync(path.join(dir, 'data.bin'), BINARY)
  fs.writeFileSync(path.join(dir, '中文文件.md'), 'unicode name ok')
  // File symlink → stored as target content; broken symlink → skipped;
  // dir symlink pointing back at the run dir → must not recurse (cycle).
  fs.symlinkSync(path.join(dir, 'patch.md'), path.join(dir, 'link.txt'))
  fs.symlinkSync(path.join(dir, 'no-such-file'), path.join(dir, 'broken.txt'))
  fs.symlinkSync(dir, path.join(dir, 'loop'))
  return dir
}

function insertTerminalRun(runId: string): void {
  const completed = Date.now() - 15 * DAY_MS // past the 14-day window
  db.insert(evolutionRuns).values({
    id: runId,
    workspacePath: tmpDir,
    status: 'applied',
    triggerKind: 'manual',
    sourceSession: 'sid_test',
    createdAt: completed - DAY_MS,
    completedAt: completed,
  }).run()
}

function insertTerminalApply(applyId: string): void {
  const completed = Date.now() - 15 * DAY_MS
  db.insert(evolutionApplies).values({
    id: applyId,
    workspacePath: tmpDir,
    status: 'applied',
    sourceRunIds: '[]',
    createdAt: completed - DAY_MS,
    completedAt: completed,
  }).run()
}

describe('evolution archive (pure-JS zip)', () => {
  it('zips a terminal run completely, deletes the dir, stamps archived_at', async () => {
    const runId = 'run-zip-test'
    const runDir = buildRunDir(runId)
    insertTerminalRun(runId)

    const summary = await runArchivePass()
    expect(summary.errors).toEqual([])
    expect(summary.archived).toBe(1)

    // Live dir gone, zip in place, row stamped.
    const zipPath = path.join(tmpDir, '.halo', 'evo', 'archive', `run-${runId}.zip`)
    expect(fs.existsSync(runDir)).toBe(false)
    expect(fs.existsSync(zipPath)).toBe(true)
    expect(db.select().from(evolutionRuns).where(eq(evolutionRuns.id, runId)).get()!.archivedAt).not.toBeNull()

    // Round-trip: every file back out, byte-identical.
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
    const files = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name).sort()
    expect(files).toEqual([
      'data.bin',
      'link.txt',          // file symlink → target content
      'patch.md',
      'sandbox/nested/deep.txt',
      '中文文件.md',
      // 'broken.txt' and 'loop' deliberately absent
    ])
    expect(await zip.file('patch.md')!.async('string')).toBe('# patch\nhello evo\n')
    expect(await zip.file('sandbox/nested/deep.txt')!.async('string')).toBe('deep content')
    expect(await zip.file('中文文件.md')!.async('string')).toBe('unicode name ok')
    expect(BINARY.equals(await zip.file('data.bin')!.async('nodebuffer'))).toBe(true)
    expect(await zip.file('link.txt')!.async('string')).toBe('# patch\nhello evo\n')
    // Empty dir preserved as a folder entry.
    expect(Object.keys(zip.files).some((n) => n === 'empty-dir/' && zip.files[n]!.dir)).toBe(true)

    // Interop: real unzip accepts the archive (skipped where the binary
    // is missing — jszip round-trip above still guards completeness).
    const unzipCheck = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf-8' })
    if (!unzipCheck.error) {
      expect(unzipCheck.status, unzipCheck.stdout + unzipCheck.stderr).toBe(0)
    }

    // Idempotent: second pass has nothing left to archive.
    const again = await runArchivePass()
    expect(again.archived).toBe(0)
    expect(again.errors).toEqual([])
  })

  it('archives apply artifacts through the same path', async () => {
    const applyId = 'apply-zip-test'
    const applyDir = path.join(tmpDir, '.halo', 'evo', 'applies', applyId)
    fs.mkdirSync(applyDir, { recursive: true })
    fs.writeFileSync(path.join(applyDir, 'apply.log'), 'log line\n')
    insertTerminalApply(applyId)

    const summary = await runArchivePass()
    expect(summary.errors).toEqual([])
    expect(summary.archived).toBe(1)

    const zipPath = path.join(tmpDir, '.halo', 'evo', 'archive', `apply-${applyId}.zip`)
    expect(fs.existsSync(applyDir)).toBe(false)
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
    expect(await zip.file('apply.log')!.async('string')).toBe('log line\n')
  })

  it('active or fresh rows are never archived', async () => {
    // Running row — active status.
    db.insert(evolutionRuns).values({
      id: 'run-active',
      workspacePath: tmpDir,
      status: 'running',
      triggerKind: 'manual',
      sourceSession: 'sid_test',
      createdAt: Date.now() - 20 * DAY_MS,
      completedAt: null,
    }).run()
    // Terminal but inside the 14-day window.
    db.insert(evolutionRuns).values({
      id: 'run-fresh',
      workspacePath: tmpDir,
      status: 'applied',
      triggerKind: 'manual',
      sourceSession: 'sid_test',
      createdAt: Date.now() - 2 * DAY_MS,
      completedAt: Date.now() - DAY_MS,
    }).run()
    const dirActive = path.join(tmpDir, '.halo', 'evo', 'runs', 'run-active')
    const dirFresh = path.join(tmpDir, '.halo', 'evo', 'runs', 'run-fresh')
    fs.mkdirSync(dirActive, { recursive: true })
    fs.mkdirSync(dirFresh, { recursive: true })

    const summary = await runArchivePass()
    expect(summary.archived).toBe(0)
    expect(fs.existsSync(dirActive)).toBe(true)
    expect(fs.existsSync(dirFresh)).toBe(true)
  })
})
