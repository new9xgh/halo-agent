/**
 * Lightweight `.git` directory watcher — fires a single callback whenever a
 * command-line git operation (commit / checkout / add / reset run by the user
 * in a terminal) mutates the repo, so the Source Control panel auto-refreshes.
 *
 * Why a separate watcher and not WorkspaceWatcher: WorkspaceWatcher deliberately
 * ignores all of `.git` (watching it recursively buries @parcel/watcher under
 * tens of thousands of object inodes). But git's own writes only touch a few
 * files at the TOP of `.git` — `index` (staging) and `HEAD` (branch/commit
 * pointer) — never the big object/ subtree. So a NON-recursive `fs.watch` on
 * the `.git` directory alone (node's built-in, not parcel) catches every such
 * operation at zero inode cost: it observes only the directory's direct
 * children, so there's nothing to recurse into.
 *
 * Panel writes (the SC panel's own commit/stage/push) already re-broadcast
 * `file:changed` from routes/git.ts; this fills the remaining gap of changes
 * made outside the panel.
 */
import fs, { type FSWatcher } from 'node:fs'
import path from 'node:path'

export type GitDirChangeCallback = () => void

export class GitDirWatcher {
  private watcher: FSWatcher | null = null
  private workspaceRoot: string | null = null
  private callback: GitDirChangeCallback | null = null
  /** Debounce: a single git op fires several events in a burst; collapse the
   *  window into one callback. Mirrors WorkspaceWatcher's scheduleFlush style
   *  (fixed window from the first event, not reset per event). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  setCallback(cb: GitDirChangeCallback): void {
    this.callback = cb
  }

  start(workspaceRoot: string): void {
    if (this.watcher && this.workspaceRoot === workspaceRoot) return
    this.stop()

    // Only watch real git work-trees. A non-git workspace has no `.git`, which
    // is a normal state — just don't watch (no error).
    const gitDir = path.join(workspaceRoot, '.git')
    if (!fs.existsSync(gitDir)) return

    try {
      this.watcher = fs.watch(gitDir, { persistent: true, recursive: false }, (_eventType, filename) => {
        this.handleEvent(filename)
      })
      this.workspaceRoot = workspaceRoot
    } catch (err) {
      // fs.watch can throw (permissions, unsupported FS). Don't take the
      // connection down — just lose git auto-refresh for this workspace.
      console.warn(`[GitDirWatcher] failed to watch ${gitDir}: ${err instanceof Error ? err.message : String(err)}`)
      this.watcher = null
      this.workspaceRoot = null
    }
  }

  /** Only `index` (staging) and `HEAD` (branch/commit pointer) reflect a state
   *  change the panel cares about. Matching them exactly also drops the
   *  `index.lock`/`HEAD.lock` churn (distinct filenames) and everything else
   *  (COMMIT_EDITMSG, logs/, objects/), all of which move together with
   *  index/HEAD anyway — so one signal per op suffices. */
  private handleEvent(filename: string | Buffer | null): void {
    if (filename !== 'index' && filename !== 'HEAD') return
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.callback?.()
    }, 350) // 350ms debounce — collapses a git op's event burst into one call
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    this.workspaceRoot = null
  }
}
