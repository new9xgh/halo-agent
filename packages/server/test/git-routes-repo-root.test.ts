import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createGitRoutes } from '../src/routes/git.js'

/**
 * Contract: every READ endpoint in routes/git.ts is gated on `isRepoRoot()`.
 *
 * git resolves `.git` by walking UP the tree, so a workspace nested inside an
 * ancestor repo (dotfiles `$HOME`, monorepo subdir) reports that ancestor's
 * data unless the route gates on it. `/git/ignored` shipped without the gate
 * and leaked the ancestor's ignored paths (incl. `.env` / `credentials.json`
 * names); `/git/diff` leaked the ancestor's file *contents*. The guard is a
 * design promise (INDEX.md, Source Control) — pin it per route so a new read
 * endpoint that forgets it fails here instead of in production.
 *
 * core/test/git-manager.test.ts covers isRepoRoot itself; this covers the
 * routes' use of it and the exact response shapes the admin reads.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

describe('git routes: isRepoRoot gate on read endpoints', () => {
  let ancestor: string
  let nested: string
  const app = createGitRoutes()

  const get = async (route: string, projectId: string) => {
    const res = await app.request(`${route}${route.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  beforeAll(() => {
    ancestor = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-git-routes-'))
    git(ancestor, 'init')
    // Secret-ish content in the ancestor: the leak under test.
    fs.writeFileSync(path.join(ancestor, '.gitignore'), 'secrets.env\n')
    fs.writeFileSync(path.join(ancestor, 'secrets.env'), 'TOKEN=leaked')
    fs.writeFileSync(path.join(ancestor, 'tracked.txt'), 'ancestor content')
    git(ancestor, 'add', '-A')
    git(ancestor, 'commit', '-m', 'ancestor commit')
    git(ancestor, 'remote', 'add', 'origin', 'https://github.com/ancestor-org/private-repo.git')

    nested = path.join(ancestor, 'sub', 'workspace')
    fs.mkdirSync(nested, { recursive: true })
  })

  afterAll(() => {
    fs.rmSync(ancestor, { recursive: true, force: true })
  })

  it('/git/ignored reports isRepo:false with an empty (never undefined) list', async () => {
    const { status, body } = await get('/git/ignored', nested)
    expect(status).toBe(200)
    expect(body.isRepo).toBe(false)
    // The explorer reads `ign.ignored` unconditionally — must be present.
    expect(body.ignored).toEqual([])
  })

  it('/git/status reports isRepo:false (the already-correct reference shape)', async () => {
    const { body } = await get('/git/status', nested)
    expect(body.isRepo).toBe(false)
    expect(body.files).toBeUndefined()
  })

  it('/git/log leaks no ancestor commits', async () => {
    const { body } = await get('/git/log', nested)
    expect(body.commits).toEqual([])
  })

  it('/git/commit-files leaks no ancestor commit contents', async () => {
    const hash = git(ancestor, 'rev-parse', 'HEAD').trim()
    const { body } = await get(`/git/commit-files?hash=${hash}`, nested)
    expect(body.files).toEqual([])
  })

  it('/git/diff leaks no ancestor file contents', async () => {
    const { body } = await get('/git/diff?path=tracked.txt&staged=0', nested)
    expect(body.original).toBe('')
    expect(body.modified).toBe('')
  })

  it('/git/remotes leaks no ancestor remote URL', async () => {
    const { body } = await get('/git/remotes', nested)
    expect(body.remotes).toEqual([])
  })

  it('/git/remote/protocol leaks no ancestor remote URL', async () => {
    const { body } = await get('/git/remote/protocol', nested)
    expect(body.url).toBe('')
    expect(body.protocol).toBe('other')
  })

  it('a real repo root still gets its own data through every read endpoint', async () => {
    // Same assertions from the ancestor root itself — proves the gate rejects
    // only nesting, not the happy path.
    expect((await get('/git/status', ancestor)).body.isRepo).toBe(true)
    expect((await get('/git/ignored', ancestor)).body.ignored).toEqual(['secrets.env'])
    expect((await get('/git/log', ancestor)).body.commits).toHaveLength(1)
    expect((await get('/git/diff?path=tracked.txt&staged=0', ancestor)).body.original).toBe('ancestor content')
    expect((await get('/git/remotes', ancestor)).body.remotes).toHaveLength(1)
    expect((await get('/git/remote/protocol', ancestor)).body.protocol).toBe('https')
  })

  it('/git/init still works from a nested folder — it must NOT get the gate', async () => {
    // Load-bearing counterpart to the reads above, and the one case the guard
    // must never grow to cover: gating /git/init would make "Initialize
    // Repository" a dead button for exactly the folders that need it (see
    // getGitForRead's JSDoc and git-manager.ts init()).
    const target = path.join(ancestor, 'sub', 'init-me')
    fs.mkdirSync(target, { recursive: true })
    const res = await app.request('/git/init', {
      method: 'POST',
      body: JSON.stringify({ projectId: target }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true })
    // Its OWN repo, not the ancestor's.
    expect(fs.realpathSync(git(target, 'rev-parse', '--show-toplevel').trim())).toBe(fs.realpathSync(target))
    // Reads flip on now that it is a root.
    expect((await get('/git/status', target)).body.isRepo).toBe(true)
    // And nothing landed in the ancestor's history.
    expect((await get('/git/log', ancestor)).body.commits).toHaveLength(1)
  })
})

describe('git routes: a plain non-repo folder (not nested in any repo)', () => {
  // The highest regression risk of the guard change: the ordinary first-run
  // workspace. It must read as isRepo:false (gate ② empty state, no 500) and
  // still be initializable.
  let plain: string
  const app = createGitRoutes()

  const get = async (route: string, projectId: string) => {
    const res = await app.request(`${route}?projectId=${encodeURIComponent(projectId)}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  beforeAll(() => {
    // mkdtemp directly under the OS tmpdir, so there is no ancestor repo at all.
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-git-plain-'))
    fs.writeFileSync(path.join(plain, 'file.txt'), 'hello')
  })

  afterAll(() => {
    fs.rmSync(plain, { recursive: true, force: true })
  })

  it('reads report isRepo:false / empty instead of erroring', async () => {
    const status = await get('/git/status', plain)
    expect(status.status).toBe(200)
    expect(status.body.isRepo).toBe(false)
    expect((await get('/git/ignored', plain)).body.ignored).toEqual([])
    expect((await get('/git/log', plain)).body.commits).toEqual([])
  })

  it('/git/init turns it into a repo and the reads follow', async () => {
    const res = await app.request('/git/init', {
      method: 'POST',
      body: JSON.stringify({ projectId: plain }),
    })
    expect(res.status).toBe(200)
    expect((await get('/git/status', plain)).body.isRepo).toBe(true)
    const { body } = await get('/git/log', plain)
    expect(body.commits).toHaveLength(1)
    expect((body.commits as Array<{ message: string }>)[0]!.message).toBe('Initial commit')
  })
})
