/**
 * UI-log archiving — the `messages` half of a session file only ever grew.
 * `rawMessages` has compaction; the UI log had nothing, so a long-lived
 * session ended up multi-MB (measured: 6.9MB of 7.4MB was UI messages).
 *
 * On compact the older exchanges move out into `<seg>.arch.<N>.json.gz` next
 * to the active `.json`, and the recent tail stays in place. The active file's
 * shape is unchanged, so every existing reader keeps working untouched.
 *
 * Segments are append-only: `N` counts up from 1, and a written segment is
 * read-only forever. The active file's `archiveCount` header field is the
 * commit marker — a segment with `N > archiveCount` was never committed and no
 * reader may reference it, which is what makes the two-step write crash-safe
 * (see `SessionUIStore.archiveOldMessages`).
 */
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { SessionMessage } from './session-types.js'

/**
 * How many trailing main user exchanges stay in the active file.
 *
 * Not aligned with `config.compact.keep_messages`: that counts raw
 * (LLM-facing) messages, and one raw turn expands into many UI messages
 * (tool_call / tool_result / usage / context rows), so there is no honest
 * mapping between the two granularities — matching them would need the same
 * text-matching heuristic `deleteExchange` uses, which already degrades
 * silently. A fixed exchange count is the predictable degradation the design
 * calls for. No setting: one number, tuned once.
 */
export const ARCHIVE_KEEP_EXCHANGES = 15

/** `<seg>.arch.<N>.json.gz` — `seg` is `fileSegment(sessionId)`, the same leaf
 *  base the active `<seg>.json` uses. */
function segmentPath(dir: string, seg: string, n: number): string {
  return path.join(dir, `${seg}.arch.${n}.json.gz`)
}

/**
 * Index to split the UI log at: `messages[0..cut)` is archivable, `[cut..]`
 * stays in the active file. 0 = nothing to archive.
 *
 * The split is always the START of a main user exchange (`role === 'user'`
 * without `taskId` — the same "main conversation" subset the admin renders and
 * `deleteExchange` counts ordinals on), so a turn's responses are never cut in
 * half. Keeping the last `keepExchanges` of them also keeps the in-flight turn
 * out of the archive by construction: its user message is the newest one, so a
 * mid-turn compact can never archive the turn it is running inside.
 */
export function archiveSplitIndex(
  messages: SessionMessage[],
  keepExchanges: number = ARCHIVE_KEEP_EXCHANGES,
): number {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && !messages[i].taskId) starts.push(i)
  }
  if (starts.length <= keepExchanges) return 0
  return starts[starts.length - keepExchanges]
}

/** Committed segment count, read from the active file's header. 0 when the
 *  file is missing/unreadable — the next segment is then 1. */
export function readArchiveCount(dir: string, seg: string): number {
  try {
    const data = JSON.parse(fsSync.readFileSync(path.join(dir, `${seg}.json`), 'utf-8')) as { archiveCount?: number }
    return typeof data.archiveCount === 'number' ? data.archiveCount : 0
  } catch {
    return 0
  }
}

/**
 * Write segment `n`. No temp+rename dance: a segment only becomes readable
 * once the active file's `archiveCount` reaches `n`, so a half-written or
 * stale file at this path is by definition uncommitted and this call
 * overwrites it (the resume-after-crash path, idempotent for the same `n`).
 */
export function writeArchiveSegment(dir: string, seg: string, n: number, messages: SessionMessage[]): void {
  fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(segmentPath(dir, seg, n), gzipSync(JSON.stringify(messages)))
}

/**
 * Read segment `n` back. Null when the file is missing or unreadable — callers
 * must additionally check `n <= readArchiveCount(...)`, since an uncommitted
 * segment left by a crash is present on disk but not part of the log.
 */
export function readArchiveSegment(dir: string, seg: string, n: number): SessionMessage[] | null {
  try {
    return JSON.parse(gunzipSync(fsSync.readFileSync(segmentPath(dir, seg, n))).toString('utf-8')) as SessionMessage[]
  } catch {
    return null
  }
}

/**
 * Delete every archive segment of a session. Driven by a filesystem glob, not
 * by the header's `archiveCount` or any in-memory state: whatever is on disk
 * goes, including segments left uncommitted by a crash.
 */
export async function deleteArchiveSegments(dir: string, seg: string): Promise<void> {
  const prefix = `${seg}.arch.`
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.json.gz')) continue
    try { await fs.rm(path.join(dir, name)) } catch { /* raced with another delete */ }
  }
}
