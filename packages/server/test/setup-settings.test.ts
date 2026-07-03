import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: setup-settings round-trips `~/.halo/secrets/settings.yaml`
 * preserving user comments and ordering (yaml Document API, not parse+dump),
 * creates intermediate maps for fresh namespaces (the `ensurePath` fix), and
 * writes 0600 since the file holds API keys.
 *
 * SETTINGS_PATH resolves from os.homedir() at module load → redirect HOME to
 * a temp dir BEFORE the dynamic import.
 */

let tmpHome: string
let settingsPath: string
let mod: typeof import('../src/setup-settings.js')

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-setup-settings-'))
  process.env.HOME = tmpHome
  mod = await import('../src/setup-settings.js')
  settingsPath = path.join(tmpHome, '.halo', 'secrets', 'settings.yaml')
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(settingsPath, { force: true })
})

describe('writeSetting / readSetting', () => {
  it('creates the file with intermediate maps on a FRESH doc (ensurePath)', () => {
    // yaml's setIn throws unless every ancestor already exists as a map —
    // this pins the ensurePath walk that creates them.
    mod.writeSetting('deepseek.secrets.api_key', 'sk-123')
    expect(mod.readSetting('deepseek.secrets.api_key')).toBe('sk-123')
  })

  it('file lands with 0600 permissions (holds API keys)', () => {
    mod.writeSetting('a.secrets.k', 'v')
    const mode = fs.statSync(settingsPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('returns undefined for a missing leaf', () => {
    expect(mod.readSetting('never.set.this')).toBeUndefined()
  })

  it('empty string / null clears the leaf', () => {
    mod.writeSetting('x.params.key', 'value')
    mod.writeSetting('x.params.key', '')
    expect(mod.readSetting('x.params.key')).toBeUndefined()
    mod.writeSetting('x.params.key', 'value2')
    mod.writeSetting('x.params.key', null)
    expect(mod.readSetting('x.params.key')).toBeUndefined()
  })

  it('preserves comments and unrelated keys on round-trip', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '# user comment stays\nexisting:\n  params:\n    keep: me\n')
    mod.writeSetting('other.secrets.token', 't')
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    expect(raw).toContain('# user comment stays')
    expect(mod.readSetting('existing.params.keep')).toBe('me')
    expect(mod.readSetting('other.secrets.token')).toBe('t')
  })

  it('keeps a literal <<ENV>> placeholder verbatim (setup writes, runtime expands)', () => {
    mod.writeSetting('deepseek.secrets.api_key', '<<DEEPSEEK_API_KEY>>')
    expect(mod.readSetting('deepseek.secrets.api_key')).toBe('<<DEEPSEEK_API_KEY>>')
  })

  it('handles an empty existing file (whitespace only)', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '\n  \n')
    mod.writeSetting('a.secrets.b', 'c')
    expect(mod.readSetting('a.secrets.b')).toBe('c')
  })
})

describe('writeSettings (bulk)', () => {
  it('writes multiple leaves in one round-trip, mixing set and clear', () => {
    mod.writeSetting('a.secrets.gone', 'x')
    mod.writeSettings({
      'a.secrets.k1': 'v1',
      'b.params.k2': 'v2',
      'a.secrets.gone': null,
    })
    expect(mod.readSetting('a.secrets.k1')).toBe('v1')
    expect(mod.readSetting('b.params.k2')).toBe('v2')
    expect(mod.readSetting('a.secrets.gone')).toBeUndefined()
  })
})

describe('maskSecret', () => {
  it('keeps last 4 chars, masks the rest with at least 4 stars', () => {
    expect(mod.maskSecret('sk-abcdef1234')).toBe('*********1234')
    expect(mod.maskSecret('12345')).toBe('****2345')
  })
  it('short values are fully masked', () => {
    expect(mod.maskSecret('abcd')).toBe('****')
    expect(mod.maskSecret('ab')).toBe('**')
  })
  it('empty → empty', () => {
    expect(mod.maskSecret('')).toBe('')
  })
})
