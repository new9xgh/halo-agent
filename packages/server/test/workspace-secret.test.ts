import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: getServerSecret / resolveApiKey honor the workspace overlay —
 * `<ws>/.halo/settings.yaml` wins over `~/.halo/secrets/settings.yaml`, the
 * read order the settings UI promises (default <- global <- workspace).
 * Regression guard for the "workspace-scoped provider key never reached the
 * model call" bug: the runtime read only global settings, so a key configured
 * per-workspace looked fine in the UI but requests went out unauthenticated.
 *
 * config.ts resolves paths from os.homedir() at module load → redirect HOME
 * to a temp dir BEFORE the dynamic import.
 */

let tmpHome: string
let tmpWs: string
let mod: typeof import('../src/config.js')

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-secret-home-'))
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-secret-ws-'))
  process.env.HOME = tmpHome
  fs.mkdirSync(path.join(tmpHome, '.halo', 'secrets'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpHome, '.halo', 'secrets', 'settings.yaml'),
    'anthropic:\n  secrets:\n    api_key: global-key\nkimi:\n  secrets:\n    api_key: kimi-global\n',
  )
  fs.mkdirSync(path.join(tmpWs, '.halo'), { recursive: true })
  fs.writeFileSync(
    path.join(tmpWs, '.halo', 'settings.yaml'),
    'anthropic:\n  secrets:\n    api_key: ws-key\nqwen:\n  secrets:\n    api_key: <<HALO_TEST_QWEN_KEY>>\n',
  )
  mod = await import('../src/config.js')
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.rmSync(tmpWs, { recursive: true, force: true })
  delete process.env.HALO_TEST_QWEN_KEY
})

describe('getServerSecret workspace overlay', () => {
  it('workspace value overrides global', () => {
    expect(mod.getServerSecret('anthropic', 'api_key', tmpWs)).toBe('ws-key')
  })

  it('falls back to global when workspace has no entry', () => {
    expect(mod.getServerSecret('kimi', 'api_key', tmpWs)).toBe('kimi-global')
  })

  it('reads global when no workspaceRoot given (legacy call sites)', () => {
    expect(mod.getServerSecret('anthropic', 'api_key')).toBe('global-key')
  })

  it('expands <<ENV>> placeholders in workspace values', () => {
    process.env.HALO_TEST_QWEN_KEY = 'from-env'
    expect(mod.getServerSecret('qwen', 'api_key', tmpWs)).toBe('from-env')
  })

  it('resolveApiKey passes workspaceRoot through', () => {
    expect(mod.resolveApiKey('anthropic', tmpWs)).toBe('ws-key')
    expect(mod.resolveApiKey('anthropic')).toBe('global-key')
  })

  it('resolveAwsCredentials passes workspaceRoot through', () => {
    fs.appendFileSync(
      path.join(tmpWs, '.halo', 'settings.yaml'),
      'aws-bedrock-claude-invoke:\n  secrets:\n    access_key_id: ws-ak\n    secret_access_key: ws-sk\n',
    )
    const creds = mod.resolveAwsCredentials('aws-bedrock-claude-invoke', tmpWs)
    expect(creds.accessKeyId).toBe('ws-ak')
    expect(creds.secretAccessKey).toBe('ws-sk')
  })

  it('picks up workspace file changes (mtime cache invalidation)', () => {
    const p = path.join(tmpWs, '.halo', 'settings.yaml')
    const prev = fs.statSync(p)
    fs.writeFileSync(p, 'anthropic:\n  secrets:\n    api_key: rotated-key\n')
    // Ensure mtime actually moves even on coarse-grained filesystems
    fs.utimesSync(p, prev.atime, new Date(prev.mtimeMs + 1000))
    expect(mod.getServerSecret('anthropic', 'api_key', tmpWs)).toBe('rotated-key')
  })
})
