/**
 * mtime-keyed parse cache, shared by the routes that scan a directory of
 * `<id>/<definition-file>` dirs on every request (agent-configs.ts's
 * `agent.yaml`, skills.ts + halo-city.ts's `SKILL.md`).
 *
 * The invariant all of them need: re-`stat` each file per request and only
 * re-read+parse when its mtime moved. A `stat` is ~one syscall, vs
 * `readFile + parse` which dominates the cost — so a scan stays O(N stat)
 * at steady state.
 *
 * Why per-file (not per-dir): editing an existing definition file only bumps
 * that file's mtime, not the parent dir's, so a "invalidate on parent dir
 * mtime" scheme silently serves stale content after an in-place edit.
 *
 * Only the bookkeeping is shared. Reading and parsing stay at the call site:
 * one scanner is sync (halo-city, called from a sync handler), two are
 * `fs/promises`, and each has its own fallback for a missing/unparseable
 * file (bare entry / legacy `skill.yaml` / skip).
 */
export interface MtimeCache<T> {
  /** Cached value for `filePath`, or undefined when absent or stale. */
  get(filePath: string, mtimeMs: number): T | undefined
  /** Cache `value` under `filePath`'s current mtime and return it. */
  set(filePath: string, mtimeMs: number, value: T): T
}

export function createMtimeCache<T>(): MtimeCache<T> {
  const entries = new Map<string, { mtimeMs: number; value: T }>()
  return {
    get(filePath, mtimeMs) {
      const hit = entries.get(filePath)
      return hit && hit.mtimeMs === mtimeMs ? hit.value : undefined
    },
    set(filePath, mtimeMs, value) {
      entries.set(filePath, { mtimeMs, value })
      return value
    },
  }
}
