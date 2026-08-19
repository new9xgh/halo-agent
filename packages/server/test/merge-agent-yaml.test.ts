import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { mergeAgentYaml, writeFileAtomic } from '../src/init.js'

/**
 * Contract: the built-in-agent reseed (mergeAgentYaml, called from
 * forceCopyAgentDir on every ensureHaloHome pass) force-overwrites
 * platform-owned fields (system_prompt / tools / skills) but preserves the
 * user's `model:` AND `context:` blocks — both are editable from the admin
 * Agents form. Clobbering `context:` was the "agent max context resets to
 * 200K after restart" bug: the desktop shell reseeds on every launch, the
 * server on every template upgrade, `halo setup` unconditionally.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-merge-agent-yaml-'))
const srcPath = path.join(tmpDir, 'template.yaml')
const dstPath = path.join(tmpDir, 'agent.yaml')

const TEMPLATE = [
  'name: Default',
  'system_prompt: platform prompt v2',
  'model:',
  '  provider: aws-bedrock-claude-invoke',
  '  id: template-model',
  'context:',
  '  maxTokens: 200000',
  '  compressAt: 0.8',
  'tools:',
  '  - file_read',
  '',
].join('\n')

beforeEach(() => {
  fs.writeFileSync(srcPath, TEMPLATE, 'utf-8')
  fs.rmSync(dstPath, { force: true })
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('mergeAgentYaml', () => {
  it('first install: copies the template as-is', () => {
    mergeAgentYaml(srcPath, dstPath)
    const parsed = YAML.parse(fs.readFileSync(dstPath, 'utf-8'))
    expect(parsed.context.maxTokens).toBe(200000)
    expect(parsed.model.id).toBe('template-model')
  })

  it('preserves user model AND context blocks; overwrites platform fields', () => {
    fs.writeFileSync(dstPath, [
      'name: Default',
      'system_prompt: stale user copy',
      'model:',
      '  provider: deepseek',
      '  id: user-model',
      'context:',
      '  maxTokens: 500000',
      '  compressAt: 0.85',
      'tools:',
      '  - shell_exec',
      '',
    ].join('\n'), 'utf-8')

    mergeAgentYaml(srcPath, dstPath)
    const parsed = YAML.parse(fs.readFileSync(dstPath, 'utf-8'))
    // User-owned blocks survive the reseed
    expect(parsed.model.id).toBe('user-model')
    expect(parsed.model.provider).toBe('deepseek')
    expect(parsed.context.maxTokens).toBe(500000)
    expect(parsed.context.compressAt).toBe(0.85)
    // Platform-owned fields come from the template
    expect(parsed.system_prompt).toBe('platform prompt v2')
    expect(parsed.tools).toEqual(['file_read'])
  })

  it('falls back to template blocks when the user yaml has none', () => {
    fs.writeFileSync(dstPath, 'name: Default\nsystem_prompt: old\n', 'utf-8')
    mergeAgentYaml(srcPath, dstPath)
    const parsed = YAML.parse(fs.readFileSync(dstPath, 'utf-8'))
    expect(parsed.context.maxTokens).toBe(200000)
    expect(parsed.model.id).toBe('template-model')
  })

  // Atomic-write + idempotent-skip contract: the every-launch desktop reseed
  // must neither churn mtimes on unchanged files nor leave a window where a
  // concurrent loadAgentYaml can read a truncated agent.yaml.
  it('second merge with identical content skips the write (mtime unchanged)', () => {
    mergeAgentYaml(srcPath, dstPath)
    const before = fs.statSync(dstPath).mtimeMs
    const content = fs.readFileSync(dstPath, 'utf-8')
    // Backdate mtime so a rewrite is detectable even on coarse-mtime filesystems.
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(dstPath, past, past)
    mergeAgentYaml(srcPath, dstPath)
    expect(fs.statSync(dstPath).mtimeMs).toBeLessThan(before)
    expect(fs.readFileSync(dstPath, 'utf-8')).toBe(content)
  })

  it('leaves no .tmp residue after writing', () => {
    mergeAgentYaml(srcPath, dstPath)              // first install (copyTemplate)
    fs.writeFileSync(dstPath, 'name: Default\nsystem_prompt: old\n', 'utf-8')
    mergeAgentYaml(srcPath, dstPath)              // real merge write
    expect(fs.existsSync(`${dstPath}.tmp`)).toBe(false)
    expect(fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('writeFileAtomic', () => {
  it('writes content via tmp+rename with no residue', () => {
    const target = path.join(tmpDir, 'atomic.yaml')
    writeFileAtomic(target, 'hello: world\n')
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello: world\n')
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)
  })

  it('overwrites an existing file', () => {
    const target = path.join(tmpDir, 'atomic.yaml')
    writeFileAtomic(target, 'v1\n')
    writeFileAtomic(target, 'v2\n')
    expect(fs.readFileSync(target, 'utf-8')).toBe('v2\n')
    expect(fs.existsSync(`${target}.tmp`)).toBe(false)
  })
})
