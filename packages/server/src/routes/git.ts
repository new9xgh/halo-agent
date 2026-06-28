import { Hono } from 'hono'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Workspace, GitManager } from '@turmind/halo-core'
import { saveGitCredentials, listGitCredentials, deleteGitCredential } from '../git-credentials.js'
import {
  listSshKeys,
  getSshAgentStatus,
  unlockSshKey,
  switchRemoteProtocol,
  getRemoteProtocol,
} from '../git-ssh.js'
import { broadcast } from '../ws/broadcast.js'

/**
 * A git write (commit/stage/unstage/push/pull) only mutates `.git` internals
 * (HEAD/refs/index), which the file watcher deliberately ignores — watching
 * `.git` would overwhelm @parcel/watcher (tens of thousands of inodes). So the
 * SC panel / graph / explorer decorations never get a `file:changed` and don't
 * auto-refresh after these ops. Re-broadcast that same event ourselves (push,
 * not poll) at the explicit write point. Those three consumers debounce-refresh
 * on it with zero code change; the structural-action listeners (tree insert/
 * remove) skip it (action is 'change') and the `.halo/*`-prefixed listeners skip
 * it (path is '.git'), so nothing else reacts. One broadcast per op — idempotent.
 */
function notifyGitChanged(): void {
  broadcast({ type: 'file:changed', path: '.git', action: 'change' })
}

export function createGitRoutes() {
  const app = new Hono()

  // projectId is an absolute workspace path (same contract as files.ts).
  async function resolveProjectPath(projectId: string): Promise<string | null> {
    if (path.isAbsolute(projectId)) {
      try {
        await fs.access(projectId)
        return projectId
      } catch {
        return null
      }
    }
    return null
  }

  // Match on a path-segment boundary, not a raw string prefix (see files.ts).
  function validatePath(filePath: string, projectPath: string): boolean {
    const resolved = path.resolve(projectPath, filePath)
    const proj = path.resolve(projectPath)
    return resolved === proj || resolved.startsWith(proj + path.sep)
  }

  // Resolve + validate a projectId into a GitManager. Returns the manager or a
  // Hono JSON error response (caller returns it directly).
  async function getGit(projectId: string | undefined) {
    if (!projectId) return { error: 'projectId is required', status: 400 as const }
    const projectPath = await resolveProjectPath(projectId)
    if (!projectPath) return { error: 'Project not found', status: 404 as const }
    const git = new GitManager(new Workspace(projectPath))
    return { git, projectPath }
  }

  // GET /git/status?projectId=xxx — structured working-tree status.
  // A folder that isn't a git work-tree root (no repo, or merely nested inside
  // an ancestor's repo) is a normal state, not an error — return 200 with
  // { isRepo: false } so the client shows its "initialize" empty state without
  // a console-reddening 500. Only genuine failures fall through to 500.
  app.get('/git/status', async (c) => {
    try {
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!(await res.git.isRepoRoot())) return c.json({ isRepo: false })
      const status = await res.git.getStatus()
      return c.json({ isRepo: true, ...status })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error getting status: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/ignored?projectId=xxx — .gitignore'd paths (dirs collapsed) for
  // graying out in the explorer. Separate from /git/status so the verified
  // status path is untouched.
  app.get('/git/ignored', async (c) => {
    try {
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      const ignored = await res.git.getIgnoredPaths()
      return c.json({ ignored })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error getting ignored paths: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/diff?projectId=xxx&path=xxx&staged=0|1[&from=xxx][&commit=xxx] — two sides
  // for the diff editor. With `commit`, shows that commit's own change (parent vs
  // commit); without it, the working-tree/staged diff (unchanged behavior).
  app.get('/git/diff', async (c) => {
    try {
      const filePath = c.req.query('path')
      const staged = c.req.query('staged') === '1'
      const from = c.req.query('from') || undefined
      const commit = c.req.query('commit') || undefined
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!filePath) return c.json({ error: 'path is required' }, 400)
      if (!validatePath(filePath, res.projectPath)) {
        return c.json({ error: 'Path traversal not allowed' }, 403)
      }
      const diff = await res.git.getFileDiff(filePath, staged, from, commit)
      return c.json({ path: filePath, ...diff })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error getting diff: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/log?projectId=xxx[&limit=50] — recent commits for the Graph view
  app.get('/git/log', async (c) => {
    try {
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      const limitRaw = Number(c.req.query('limit'))
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : 50
      const commits = await res.git.getLog(limit)
      return c.json({ commits })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error getting log: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/commit-files?projectId=xxx&hash=xxx — files changed by one commit
  app.get('/git/commit-files', async (c) => {
    try {
      const hash = c.req.query('hash')
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!hash) return c.json({ error: 'hash is required' }, 400)
      const files = await res.git.getCommitFiles(hash)
      return c.json({ files })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error getting commit files: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/stage — body { projectId, paths: string[] }
  app.post('/git/stage', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string; paths?: string[] }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        return c.json({ error: 'paths is required' }, 400)
      }
      await res.git.stage(body.paths)
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error staging: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/unstage — body { projectId, paths: string[] }
  app.post('/git/unstage', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string; paths?: string[] }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        return c.json({ error: 'paths is required' }, 400)
      }
      await res.git.unstage(body.paths)
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error unstaging: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/commit — body { projectId, message }
  app.post('/git/commit', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string; message?: string }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (!body.message?.trim()) return c.json({ error: 'message is required' }, 400)
      const hash = await res.git.commit(body.message)
      notifyGitChanged()
      return c.json({ ok: true, hash })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error committing: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/push — body { projectId }. Git errors (SSH passphrase, missing
  // creds, rejected) are surfaced verbatim so the panel can show them.
  app.post('/git/push', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      await res.git.push()
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error pushing: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/pull — body { projectId }
  app.post('/git/pull', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      await res.git.pull()
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error pulling: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/init — body { projectId }. `git init` + .gitignore + initial
  // commit (core's init() is a no-op if already a repo). User-triggered only;
  // halo never auto-inits a folder.
  app.post('/git/init', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      await res.git.init()
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error initializing repo: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/remotes?projectId=xxx — configured remotes ([] when none)
  app.get('/git/remotes', async (c) => {
    try {
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      const remotes = await res.git.getRemotes()
      return c.json({ remotes })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error listing remotes: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/remote — body { projectId, name, url }. Adds a remote (name
  // defaults to origin); guides the "no remote configured" state to publish.
  app.post('/git/remote', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string; name?: string; url?: string }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      const url = body.url?.trim()
      if (!url) return c.json({ error: 'url is required' }, 400)
      await res.git.addRemote(body.name?.trim() || 'origin', url)
      notifyGitChanged()
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error adding remote: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/credentials — { credentials: [{ host, username }] } (never the token)
  app.get('/git/credentials', (c) => {
    try {
      return c.json({ credentials: listGitCredentials() })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error reading credentials: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/credentials — body { host, username, token }
  app.post('/git/credentials', async (c) => {
    try {
      const body = await c.req.json<{ host?: string; username?: string; token?: string }>()
      const host = body.host?.trim()
      const username = body.username?.trim()
      const token = body.token
      if (!host || !username || !token) {
        return c.json({ error: 'host, username and token are required' }, 400)
      }
      saveGitCredentials({ host, username, token })
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error saving credentials: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // DELETE /git/credentials/:host — remove the credential for one host (host is
  // sent encodeURIComponent'd by the client; Hono decodes the param for us).
  app.delete('/git/credentials/:host', (c) => {
    try {
      const host = c.req.param('host')
      if (!host) return c.json({ error: 'host is required' }, 400)
      deleteGitCredential(host)
      return c.json({ ok: true })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error deleting credentials: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/ssh/keys — private keys in ~/.ssh + encrypted flag (no key contents)
  app.get('/git/ssh/keys', (c) => {
    try {
      return c.json({ keys: listSshKeys() })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error listing ssh keys: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/ssh/agent — ssh-agent reachability + loaded keys
  app.get('/git/ssh/agent', (c) => {
    try {
      return c.json(getSshAgentStatus())
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error reading ssh agent: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/ssh/unlock — body { keyPath, passphrase }. Loads a passphrase-
  // protected key into the shared ssh-agent. keyPath must resolve to a file
  // directly inside ~/.ssh (reject traversal / arbitrary paths). A wrong
  // passphrase is a normal 200 { ok: false, error } so the client shows it
  // inline; only malformed input / server faults are non-2xx. The passphrase is
  // never logged.
  app.post('/git/ssh/unlock', async (c) => {
    try {
      const body = await c.req.json<{ keyPath?: string; passphrase?: string }>()
      const keyPath = body.keyPath
      const passphrase = body.passphrase
      if (!keyPath || typeof passphrase !== 'string') {
        return c.json({ error: 'keyPath and passphrase are required' }, 400)
      }
      const sshDir = path.join(os.homedir(), '.ssh')
      const resolved = path.resolve(keyPath)
      if (path.dirname(resolved) !== path.resolve(sshDir)) {
        return c.json({ error: 'keyPath must be inside ~/.ssh' }, 400)
      }
      return c.json(unlockSshKey(resolved, passphrase))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error unlocking ssh key: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // POST /git/remote/protocol — body { projectId, to: 'https'|'ssh' }
  app.post('/git/remote/protocol', async (c) => {
    try {
      const body = await c.req.json<{ projectId?: string; to?: 'https' | 'ssh' }>()
      const res = await getGit(body.projectId)
      if ('error' in res) return c.json({ error: res.error }, res.status)
      if (body.to !== 'https' && body.to !== 'ssh') {
        return c.json({ error: "to must be 'https' or 'ssh'" }, 400)
      }
      const url = switchRemoteProtocol(res.projectPath, body.to)
      return c.json({ ok: true, url })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error switching remote protocol: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  // GET /git/remote/protocol?projectId=xxx — current origin url + protocol
  app.get('/git/remote/protocol', async (c) => {
    try {
      const res = await getGit(c.req.query('projectId'))
      if ('error' in res) return c.json({ error: res.error }, res.status)
      return c.json(getRemoteProtocol(res.projectPath))
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.log(`[Git] Error reading remote protocol: ${errorMessage}`)
      return c.json({ error: errorMessage }, 500)
    }
  })

  return app
}
