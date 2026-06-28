import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { GitDirWatcher } from '../src/ws/git-dir-watcher.js'

/**
 * Contract: GitDirWatcher fires its callback once per command-line git op that
 * mutates the repo, AND — the two-phase behavior added with the Source Control
 * visibility feature — when started on a NON-git folder, it watches the root
 * just long enough to notice a later `git init` creating `.git`, then upgrades
 * to watching `.git` and fires (so the client's repo signal flips true and the
 * Source Control entry appears without a manual refresh).
 *
 * These are real timer + real `fs.watch` + real `git` tests: fs.watch is
 * OS-driven, so we run actual git commands and wait past the 350ms debounce.
 * The watcher needs a moment to arm before the first mutation (inotify warmup),
 * so each test settles briefly after start().
 */

// Past the watcher's 350ms debounce — generous to keep the test non-flaky on a
// loaded CI box.
const DEBOUNCE_WAIT = 700
// Let fs.watch actually arm before the first filesystem mutation.
const WATCH_WARMUP = 80

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    // Deterministic identity + no signing so commits never block on config.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

describe('GitDirWatcher', () => {
  let root: string
  let watcher: GitDirWatcher
  let calls: number

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-gitwatch-'))
    watcher = new GitDirWatcher()
    calls = 0
    watcher.setCallback(() => { calls += 1 })
  })
  afterEach(() => {
    watcher.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('fires on a command-line op in an existing repo (debounced to one call)', async () => {
    git(root, 'init')
    watcher.start(root)
    await delay(WATCH_WARMUP)

    // A stage + commit touches index then HEAD — a burst that must collapse to
    // a single debounced callback.
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-m', 'first')

    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(1)
  })

  it('upgrades from a non-git folder to watching .git on git init, then keeps firing', async () => {
    // Start BEFORE the repo exists — the degraded root-watch phase.
    watcher.start(root)
    await delay(WATCH_WARMUP)

    git(root, 'init') // creates .git → should upgrade + fire once
    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(1)

    // Now prove we switched onto the .git watcher: a later op must also fire.
    fs.writeFileSync(path.join(root, 'a.txt'), 'hi')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-m', 'first')
    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(2)
  })

  it('does not fire on ordinary (non-.git) files while in the degraded phase', async () => {
    watcher.start(root)
    await delay(WATCH_WARMUP)

    // Create, modify, and delete ordinary files in the root — none is `.git`,
    // so the filename filter must drop them all (no repo wrongly "appeared").
    const f = path.join(root, 'notes.txt')
    fs.writeFileSync(f, 'one')
    fs.writeFileSync(f, 'two')
    fs.mkdirSync(path.join(root, 'subdir'))
    fs.rmSync(f)

    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(0)
  })

  it('stops cleanly with no further callbacks (git phase)', async () => {
    git(root, 'init')
    watcher.start(root)
    await delay(WATCH_WARMUP)
    watcher.stop()

    // Mutating after stop must not call back — the .git watcher was closed.
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-m', 'after-stop')

    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(0)
  })

  it('stops cleanly with no further callbacks (degraded parent phase)', async () => {
    watcher.start(root) // non-git → parent-watch phase
    await delay(WATCH_WARMUP)
    watcher.stop()

    // git init after stop must not call back — the root watcher was closed.
    git(root, 'init')
    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(0)
  })

  it('ignores index.lock / HEAD.lock noise but fires on real HEAD/index', async () => {
    git(root, 'init')
    watcher.start(root)
    await delay(WATCH_WARMUP)

    // The transient lock files git writes around each op must not trigger.
    const gitDir = path.join(root, '.git')
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '')
    fs.writeFileSync(path.join(gitDir, 'HEAD.lock'), '')
    fs.rmSync(path.join(gitDir, 'index.lock'))
    fs.rmSync(path.join(gitDir, 'HEAD.lock'))
    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(0)

    // Control: touching HEAD itself does fire (proves the watcher is live).
    fs.writeFileSync(path.join(gitDir, 'HEAD'), fs.readFileSync(path.join(gitDir, 'HEAD')))
    await delay(DEBOUNCE_WAIT)
    expect(calls).toBe(1)
  })

  it('start(newRoot) drops the old watch and follows the new workspace', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-gitwatch2-'))
    try {
      watcher.start(root) // degraded watch on the first root
      await delay(WATCH_WARMUP)
      watcher.start(other) // switch before either has a repo
      await delay(WATCH_WARMUP)

      // A .git appearing in the ABANDONED root must not fire.
      git(root, 'init')
      await delay(DEBOUNCE_WAIT)
      expect(calls).toBe(0)

      // A .git appearing in the CURRENT root must fire.
      git(other, 'init')
      await delay(DEBOUNCE_WAIT)
      expect(calls).toBe(1)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
  })
})
