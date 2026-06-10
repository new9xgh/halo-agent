import { describe, it, expect } from 'vitest'
import { renderMdBody, splitArgs } from '../src/prompts/md-vars.js'

/** Covers the standard `$ARGUMENTS` / `$1` arg syntax added for externally
 *  authored skills — kept independent of the Halo-internal `{{...}}` pass. */
describe('splitArgs', () => {
  it('splits on whitespace, respecting double quotes', () => {
    expect(splitArgs('create "my coder" extra')).toEqual(['create', 'my coder', 'extra'])
  })
  it('returns [] for empty input', () => {
    expect(splitArgs('')).toEqual([])
  })
})

describe('renderMdBody $-args', () => {
  const render = (body: string, args: string) =>
    renderMdBody(body, { builtin: { args, workspace_root: '/ws' }, settings: {} })

  it('substitutes $1..$N (1-based) and $ARGUMENTS', () => {
    expect(render('verb=$1 name=$2 all=[$ARGUMENTS]', 'create "my coder"'))
      .toBe('verb=create name=my coder all=[create "my coder"]')
  })
  it('missing positional → empty string', () => {
    expect(render('a=$1 b=$2', 'only')).toBe('a=only b=')
  })
  it('\\$ escapes to a literal $', () => {
    expect(render('literal=\\$1', 'x')).toBe('literal=$1')
  })
  it('leaves non-arg $ untouched ($PATH, $5.00, $12)', () => {
    expect(render('path=$PATH price=$5.00 n=$12', 'x')).toBe('path=$PATH price=$5.00 n=$12')
  })
  it('does not interfere with {{...}} substitution', () => {
    expect(render('arg=$1 halo={{workspace_root}}', 'go')).toBe('arg=go halo=/ws')
  })
})
