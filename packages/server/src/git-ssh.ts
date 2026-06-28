/**
 * Git SSH support for the Source Control panel — key discovery, agent status,
 * and remote-protocol switching. Sibling to git-credentials.ts (which owns the
 * HTTPS/PAT path).
 *
 * Uses the process HOME (matching git-credentials.ts), so the dev environment
 * (HOME=/home/ubuntu/halo-dev-home) is isolated automatically.
 *
 * DESIGN (command-guided, halo never touches a passphrase):
 *   halo spawns ONE ssh-agent at boot and writes its socket onto process.env.
 *   simple-git's git children inherit process.env, and the built-in terminal
 *   sets termEnv = {...process.env} — so both share that single agent. The user
 *   loads a key by running `ssh-add ~/.ssh/<key>` in the halo terminal and
 *   types the passphrase there; it goes straight to ssh-add and never passes
 *   through halo. Once loaded, push/pull just work because git sees the same
 *   SSH_AUTH_SOCK. This is process-scoped: a server restart resets the agent
 *   and the key must be re-added (like re-unlocking SSH after a reboot). HTTPS
 *   PATs are stored on disk and survive restarts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SSH_DIR = path.join(os.homedir(), '.ssh')

/** Filenames in ~/.ssh that are never private keys. */
const NON_KEY_NAMES = new Set(['known_hosts', 'known_hosts2', 'authorized_keys', 'config'])

export interface SshKeyInfo {
  /** Filename within ~/.ssh. */
  name: string
  /** Absolute path on disk (used to build the `ssh-add` command shown to the user). */
  path: string
  /** True when the key is passphrase-protected (needs `ssh-add` before use). */
  encrypted: boolean
}

export interface SshAgentStatus {
  agentRunning: boolean
  /** Key comments/paths currently loaded in the agent (`ssh-add -l`). */
  loadedKeys: string[]
}

/** PID of the ssh-agent halo spawned itself, so exit cleanup kills only ours
 *  (never an inherited/system agent). Null when we reused an existing one. */
let ownedAgentPid: number | null = null

/** A private key is a regular file in ~/.ssh that isn't a `.pub`, a known
 *  non-key (known_hosts/config/...), and whose first line is a PEM/OpenSSH
 *  private-key header. This catches id_rsa / id_ed25519 / *.pem without a
 *  hardcoded name list. */
function looksLikePrivateKey(name: string, abs: string): boolean {
  if (name.endsWith('.pub')) return false
  if (NON_KEY_NAMES.has(name)) return false
  let firstLine = ''
  try {
    const fd = fs.openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(64)
      const n = fs.readSync(fd, buf, 0, 64, 0)
      firstLine = buf.toString('utf-8', 0, n).split('\n')[0]
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
  return firstLine.includes('PRIVATE KEY-----')
}

/** A key is encrypted when `ssh-keygen -y -P ""` (try empty passphrase) fails.
 *  Works for both OpenSSH and legacy PEM formats and is non-interactive (the
 *  empty `-P` means it never prompts). */
function isKeyEncrypted(abs: string): boolean {
  const r = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', abs], { encoding: 'utf-8' })
  return r.status !== 0
}

/** Private keys found in ~/.ssh, with passphrase-protection flag. Empty when
 *  ~/.ssh is absent (e.g. fresh dev home) — never throws for that. Key contents
 *  are never read out; only metadata is returned. */
export function listSshKeys(): SshKeyInfo[] {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(SSH_DIR)
  } catch {
    return []
  }
  const keys: SshKeyInfo[] = []
  for (const name of entries) {
    const abs = path.join(SSH_DIR, name)
    try {
      if (!fs.statSync(abs).isFile()) continue
    } catch {
      continue
    }
    if (!looksLikePrivateKey(name, abs)) continue
    keys.push({ name, path: abs, encrypted: isKeyEncrypted(abs) })
  }
  return keys.sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether the shared ssh-agent is reachable on this process and which keys it
 *  holds. Reads the socket halo put on process.env at boot. */
export function getSshAgentStatus(): SshAgentStatus {
  if (!process.env.SSH_AUTH_SOCK) return { agentRunning: false, loadedKeys: [] }
  const r = spawnSync('ssh-add', ['-l'], { encoding: 'utf-8' })
  // exit 0 = has keys, 1 = running but empty, 2 = cannot connect to agent.
  if (r.status === 2) return { agentRunning: false, loadedKeys: [] }
  const loadedKeys = (r.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => l !== 'The agent has no identities.')
  return { agentRunning: true, loadedKeys }
}

/**
 * Boot-time: ensure halo holds ONE ssh-agent and that its socket is on
 * process.env, so git children (simple-git inherits process.env) and the
 * built-in terminal (termEnv = {...process.env}) share it. Reuses an inherited,
 * reachable agent if SSH_AUTH_SOCK already points at one; otherwise spawns
 * `ssh-agent -s`, adopts its socket/pid, and registers an exit handler to kill
 * only the agent we own. Never throws — SSH is optional and a hiccup here must
 * not take the server down.
 */
export function ensureSshAgent(): void {
  try {
    // Inherited + reachable agent? Reuse it (status 2 = cannot connect).
    if (process.env.SSH_AUTH_SOCK) {
      const probe = spawnSync('ssh-add', ['-l'], { encoding: 'utf-8' })
      if (probe.status !== 2) {
        console.log(`[GitSsh] using existing agent at ${process.env.SSH_AUTH_SOCK}`)
        return
      }
    }
    const r = spawnSync('ssh-agent', ['-s'], { encoding: 'utf-8' })
    if (r.status !== 0) {
      console.log('[GitSsh] ssh-agent unavailable; SSH push/pull will need a manually-started agent')
      return
    }
    // Parse `SSH_AUTH_SOCK=/tmp/...; export ...;\nSSH_AGENT_PID=123; export ...`
    const sock = /SSH_AUTH_SOCK=([^;\n]+)/.exec(r.stdout ?? '')?.[1]
    const pid = /SSH_AGENT_PID=([^;\n]+)/.exec(r.stdout ?? '')?.[1]
    if (!sock) {
      console.log('[GitSsh] could not parse ssh-agent socket; skipping')
      return
    }
    process.env.SSH_AUTH_SOCK = sock
    if (pid) {
      process.env.SSH_AGENT_PID = pid
      ownedAgentPid = Number(pid) || null
    }
    if (ownedAgentPid !== null) process.once('exit', killOwnedSshAgent)
    console.log(`[GitSsh] started agent at ${sock}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(`[GitSsh] ssh-agent init skipped: ${message}`)
  }
}

/** Kill the ssh-agent halo spawned (best-effort), only if we own it. Wired to
 *  process exit so we don't leak orphan agents across restarts. */
function killOwnedSshAgent(): void {
  if (ownedAgentPid === null) return
  try {
    process.kill(ownedAgentPid, 'SIGTERM')
  } catch {
    // already gone — fine
  }
  ownedAgentPid = null
}

/** Parse a git remote URL into { host, repoPath } where repoPath is
 *  "owner/repo.git" (no leading slash). Supports HTTPS and scp-style SSH. */
function parseRemote(url: string): { host: string; repoPath: string } {
  // scp-style SSH: git@host:owner/repo.git
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(url)
  if (scp) return { host: scp[1], repoPath: scp[2].replace(/^\//, '') }
  // ssh:// or https:// URL form
  try {
    const u = new URL(url)
    return { host: u.host, repoPath: u.pathname.replace(/^\//, '') }
  } catch {
    throw new Error(`unrecognized remote URL: ${url}`)
  }
}

/**
 * Switch the `origin` remote between HTTPS and scp-style SSH, preserving host +
 * owner/repo. Returns the new URL. Idempotent: switching to the protocol it's
 * already on just re-sets the same URL.
 */
export function switchRemoteProtocol(projectRoot: string, to: 'https' | 'ssh'): string {
  const cur = spawnSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' })
  if (cur.status !== 0) throw new Error((cur.stderr ?? 'no origin remote').trim())
  const { host, repoPath } = parseRemote((cur.stdout ?? '').trim())
  const next = to === 'ssh' ? `git@${host}:${repoPath}` : `https://${host}/${repoPath}`
  const set = spawnSync('git', ['-C', projectRoot, 'remote', 'set-url', 'origin', next], { encoding: 'utf-8' })
  if (set.status !== 0) throw new Error((set.stderr ?? 'failed to set remote url').trim())
  console.log(`[GitSsh] switched origin to ${to}`)
  return next
}

/** Current `origin` URL + which protocol it uses, for the SSH tab to display. */
export function getRemoteProtocol(projectRoot: string): { url: string; protocol: 'https' | 'ssh' | 'other' } {
  const cur = spawnSync('git', ['-C', projectRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf-8' })
  if (cur.status !== 0) return { url: '', protocol: 'other' }
  const url = (cur.stdout ?? '').trim()
  if (url.startsWith('https://')) return { url, protocol: 'https' }
  if (/^[^@]+@[^:]+:/.test(url) || url.startsWith('ssh://')) return { url, protocol: 'ssh' }
  return { url, protocol: 'other' }
}
