/**
 * Git HTTPS credential management for the Source Control panel.
 *
 * Stores a single PAT-based credential in two places (both required):
 *   (a) halo encrypted secrets (~/.halo/secrets/config.yaml, 0o600) — so the
 *       admin can display "configured for <host>" and the token survives.
 *   (b) ~/.git-credentials (0o600) — the file `git`'s `store` credential
 *       helper actually reads, so `git push/pull` over HTTPS use it.
 *
 * Uses the process HOME for both, matching setup-config.ts — so the dev
 * environment (HOME=/home/ubuntu/halo-dev-home) is isolated automatically.
 *
 * The token is never logged and never returned to the frontend.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { updateConfigLeaves, readConfigLeaf } from './setup-config.js'

const GIT_CREDENTIALS_PATH = path.join(homedir(), '.git-credentials')

export interface GitCredentialInput {
  host: string
  username: string
  token: string
}

export interface GitCredentialStatus {
  configured: boolean
  host: string
  username: string
}

/** Upsert the `https://user:token@host` line for `host` in ~/.git-credentials. */
function writeGitCredentialsFile(host: string, username: string, token: string): void {
  const line = `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@${host}`
  let lines: string[] = []
  if (fs.existsSync(GIT_CREDENTIALS_PATH)) {
    lines = fs.readFileSync(GIT_CREDENTIALS_PATH, 'utf-8').split('\n').filter((l) => l.trim() !== '')
  }
  // Replace any existing entry for the same host (one credential per host).
  const kept = lines.filter((l) => {
    try {
      return new URL(l).host !== host
    } catch {
      return true
    }
  })
  kept.push(line)
  fs.writeFileSync(GIT_CREDENTIALS_PATH, kept.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(GIT_CREDENTIALS_PATH, 0o600) } catch { /* best-effort */ }
}

/** Ensure git's `store` credential helper is configured globally so it reads
 *  ~/.git-credentials. No-op when a helper is already set. */
function ensureCredentialHelper(): void {
  const current = spawnSync('git', ['config', '--global', '--get', 'credential.helper'], { encoding: 'utf-8' })
  const helper = (current.stdout ?? '').trim()
  if (!helper) {
    spawnSync('git', ['config', '--global', 'credential.helper', 'store'], { encoding: 'utf-8' })
  }
}

/** Persist a git credential to both sinks. Throws on filesystem failure. */
export function saveGitCredentials({ host, username, token }: GitCredentialInput): void {
  updateConfigLeaves({
    'git.host': host,
    'git.username': username,
    'git.token': token,
  })
  writeGitCredentialsFile(host, username, token)
  ensureCredentialHelper()
  console.log(`[GitCredentials] saved for host ${host}`)
}

/** Status for the admin — host + username + configured flag, never the token. */
export function getGitCredentialsStatus(): GitCredentialStatus {
  const host = readConfigLeaf('git.host')
  const username = readConfigLeaf('git.username')
  const token = readConfigLeaf('git.token')
  const configured = typeof token === 'string' && token.length > 0
  return {
    configured,
    host: typeof host === 'string' ? host : '',
    username: typeof username === 'string' ? username : '',
  }
}
