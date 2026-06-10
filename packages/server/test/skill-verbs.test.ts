import { describe, it, expect } from 'vitest'
import { parseSkillFrontmatter } from '../src/agents/agent-loader.js'

/** The `verbs:` + `disable-model-invocation` frontmatter extensions that drive
 *  the noun-verb thin-command mechanism. Standard skills omit both and must
 *  still parse cleanly. */
describe('parseSkillFrontmatter — verbs & disable-model-invocation', () => {
  it('parses a verbs list with builtin flags and descriptions', () => {
    const raw = [
      '---',
      'name: agent',
      'command: /agent',
      'verbs:',
      '  - { name: list,   builtin: true,  desc: List agents }',
      '  - { name: create, builtin: false, desc: Create an agent }',
      '---',
      '# body',
    ].join('\n')
    const p = parseSkillFrontmatter(raw)
    expect(p.command).toBe('/agent')
    expect(p.verbs).toEqual([
      { name: 'list', builtin: true, desc: 'List agents' },
      { name: 'create', builtin: false, desc: 'Create an agent' },
    ])
  })

  it('standard skill (no verbs / no disable-model-invocation) parses with both undefined', () => {
    const raw = ['---', 'name: hello', 'description: hi', 'command: /hello', '---', 'body'].join('\n')
    const p = parseSkillFrontmatter(raw)
    expect(p.verbs).toBeUndefined()
    expect(p.disableModelInvocation).toBe(false)
    expect(p.command).toBe('/hello')
  })

  it('reads disable-model-invocation (kebab) as true', () => {
    const raw = ['---', 'name: x', 'disable-model-invocation: true', '---', 'b'].join('\n')
    expect(parseSkillFrontmatter(raw).disableModelInvocation).toBe(true)
  })

  it('malformed frontmatter does not throw — fields fall back to undefined', () => {
    const raw = ['---', 'name: [unclosed', 'verbs: not-a-list', '---', 'body'].join('\n')
    const p = parseSkillFrontmatter(raw)
    expect(p.verbs).toBeUndefined()
    expect(p.body).toBe('body')
  })

  it('tolerates an unquoted colon-space in description (no longer vanishes the skill)', () => {
    const raw = ['---', 'name: agent', 'command: /agent', 'description: Manage agents: create, update', '---', 'b'].join('\n')
    const p = parseSkillFrontmatter(raw)
    expect(p.command).toBe('/agent')
    expect(p.description).toBe('Manage agents: create, update')
    expect(p.name).toBe('agent')
  })

  it('keeps verbs even when description has a colon (scalar lines stripped before YAML retry)', () => {
    const raw = [
      '---', 'name: agent', 'command: /agent', 'description: Manage agents: create',
      'verbs:', '  - { name: list, builtin: true, desc: List }', '---', 'b',
    ].join('\n')
    const p = parseSkillFrontmatter(raw)
    expect(p.description).toBe('Manage agents: create')
    expect(p.verbs).toEqual([{ name: 'list', builtin: true, desc: 'List' }])
  })

  it('drops malformed verb entries (no name) but keeps valid ones', () => {
    const raw = [
      '---', 'command: /x', 'verbs:',
      '  - { name: ok, builtin: true }',
      '  - { builtin: true }',   // no name → dropped
      '---', 'b',
    ].join('\n')
    expect(parseSkillFrontmatter(raw).verbs).toEqual([{ name: 'ok', builtin: true, desc: undefined }])
  })
})
