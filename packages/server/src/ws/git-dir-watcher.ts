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
 * Two phases:
 *  - `.git` exists → watch `.git` for index/HEAD (the common, steady-state path).
 *  - `.git` missing → watch the workspace root (non-recursive) ONLY to notice
 *    `.git` appearing (a terminal `git init` / `git clone`). The moment it does,
 *    we close the root watch and upgrade to watching `.git`, firing once so the
 *    client re-queries status (its repo signal flips true → the Source Control
 *    entry surfaces). This degraded watch lives only during the non-repo window;
 *    a real repo never pays for it.
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
  /** Which directory the live watcher observes: `git` = the `.git` dir, `parent`
   *  = the workspace root awaiting `.git`. null when not watching. */
  private mode: 'git' | 'parent' | null = null
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
    this.workspaceRoot = workspaceRoot

    // A real git work-tree → watch `.git` directly. A non-git folder has no
    // `.git` yet (a normal state); watch the root so a later `git init` flips
    // us onto the `.git` path automatically.
    const gitDir = path.join(workspaceRoot, '.git')
    if (fs.existsSync(gitDir)) {
      this.watchGitDir(gitDir)
    } else {
      this.watchParentForGit(workspaceRoot)
    }
  }

  /** Watch the `.git` dir for index/HEAD changes (steady state). */
  private watchGitDir(gitDir: string): void {
    try {
      this.watcher = fs.watch(gitDir, { persistent: true, recursive: false }, (_eventType, filename) => {
        this.handleGitEvent(filename)
      })
      this.mode = 'git'
    } catch (err) {
      // fs.watch can throw (permissions, unsupported FS). Don't take the
      // connection down — just lose git auto-refresh for this workspace.
      console.warn(`[GitDirWatcher] failed to watch ${gitDir}: ${err instanceof Error ? err.message : String(err)}`)
      this.watcher = null
      this.mode = null
    }
  }

  /** Watch the workspace root (non-recursive) only to notice `.git` appearing.
   *  Exists solely during the non-repo window; upgraded away on first `.git`. */
  private watchParentForGit(workspaceRoot: string): void {
    try {
      this.watcher = fs.watch(workspaceRoot, { persistent: true, recursive: false }, (_eventType, filename) => {
        this.handleParentEvent(filename)
      })
      this.mode = 'parent'
    } catch (err) {
      console.warn(`[GitDirWatcher] failed to watch ${workspaceRoot}: ${err instanceof Error ? err.message : String(err)}`)
      this.watcher = null
      this.mode = null
    }
  }

  /** Only `index` (staging) and `HEAD` (branch/commit pointer) reflect a state
   *  change the panel cares about. Matching them exactly also drops the
   *  `index.lock`/`HEAD.lock` churn (distinct filenames) and everything else
   *  (COMMIT_EDITMSG, logs/, objects/), all of which move together with
   *  index/HEAD anyway — so one signal per op suffices. */
  private handleGitEvent(filename: string | Buffer | null): void {
    if (filename !== 'index' && filename !== 'HEAD') return
    this.scheduleFlush()
  }

  /** Root-watch events during the non-repo window. Cheapest possible filter:
   *  compare the filename and bail on anything but `.git` before touching IO,
   *  so churn from ordinary files in the root costs only a string compare. */
  private handleParentEvent(filename: string | Buffer | null): void {
    if (filename !== '.git') return
    // `git init` can enqueue more than one `.git` event; once the first has
    // upgraded us to the `.git` watcher (mode === 'git'), ignore the stragglers
    // so we don't close/reopen the freshly-attached watcher.
    if (this.mode !== 'parent') return
    const root = this.workspaceRoot
    if (!root) return
    // Confirm `.git` is really there (the event also fires on rename/removal)
    // before tearing down the root watch — otherwise a transient event could
    // leave us blind. This IO runs at most once, when `.git` first appears.
    const gitDir = path.join(root, '.git')
    if (!fs.existsSync(gitDir)) return
    // Upgrade: drop the root watch, watch `.git`, and signal once so the client
    // re-queries status (repo signal flips true → Source Control entry appears).
    this.closeWatcher()
    this.watchGitDir(gitDir)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.callback?.()
    }, 350) // 350ms debounce — collapses a git op's event burst into one call
  }

  private closeWatcher(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  stop(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.closeWatcher()
    this.workspaceRoot = null
    this.mode = null
  }
}
