import { describe, it, expect } from 'vitest'
import {
  toGraphemes,
  graphemeLength,
  insertAt,
  backspaceAt,
  deleteAt,
  deleteWordBefore,
  deleteToStart,
  deleteToEnd,
  type EditState,
} from '../src/tui/line-editor.js'

/**
 * Contract: all ops are grapheme-based (Intl.Segmenter) so the caret can never
 * land inside a CJK char, emoji, or ZWJ sequence. Every op is pure — the input
 * state must be treated as immutable, and no-op cases return the SAME object.
 */

const s = (value: string, cursor: number): EditState => ({ value, cursor })

describe('toGraphemes / graphemeLength', () => {
  it('empty string → no graphemes', () => {
    expect(toGraphemes('')).toEqual([])
    expect(graphemeLength('')).toBe(0)
  })

  it('ASCII splits per char', () => {
    expect(toGraphemes('abc')).toEqual(['a', 'b', 'c'])
  })

  it('emoji with ZWJ sequence counts as ONE grapheme', () => {
    // 👨‍👩‍👧 is 5 code points / 8 UTF-16 units but one user-perceived char.
    expect(graphemeLength('👨‍👩‍👧')).toBe(1)
  })

  it('CJK counts per character', () => {
    expect(graphemeLength('中文字')).toBe(3)
  })
})

describe('insertAt', () => {
  it('inserts at the cursor and moves cursor past the insertion', () => {
    expect(insertAt(s('ac', 1), 'b')).toEqual({ value: 'abc', cursor: 2 })
  })

  it('inserts at start and end', () => {
    expect(insertAt(s('bc', 0), 'a')).toEqual({ value: 'abc', cursor: 1 })
    expect(insertAt(s('ab', 2), 'c')).toEqual({ value: 'abc', cursor: 3 })
  })

  it('cursor advances by GRAPHEME length of inserted text, not UTF-16 length', () => {
    const out = insertAt(s('', 0), '👍中')
    expect(out.value).toBe('👍中')
    expect(out.cursor).toBe(2) // '👍' is 2 UTF-16 units but 1 grapheme
  })

  it('clamps an out-of-range cursor', () => {
    expect(insertAt(s('ab', 99), 'c')).toEqual({ value: 'abc', cursor: 3 })
  })
})

describe('backspaceAt', () => {
  it('deletes the grapheme before the cursor', () => {
    expect(backspaceAt(s('abc', 2))).toEqual({ value: 'ac', cursor: 1 })
  })

  it('deletes a whole emoji, never half a surrogate pair', () => {
    expect(backspaceAt(s('a👨‍👩‍👧b', 2))).toEqual({ value: 'ab', cursor: 1 })
  })

  it('no-op at start of line returns the same state object', () => {
    const st = s('abc', 0)
    expect(backspaceAt(st)).toBe(st)
  })
})

describe('deleteAt', () => {
  it('deletes the grapheme under the cursor, cursor stays', () => {
    expect(deleteAt(s('abc', 1))).toEqual({ value: 'ac', cursor: 1 })
  })

  it('no-op at end of line returns the same state object', () => {
    const st = s('abc', 3)
    expect(deleteAt(st)).toBe(st)
  })

  it('deletes a whole CJK char', () => {
    expect(deleteAt(s('a中b', 1))).toEqual({ value: 'ab', cursor: 1 })
  })
})

describe('deleteWordBefore (Ctrl+W, unix word rubout)', () => {
  it('deletes one word before the cursor', () => {
    expect(deleteWordBefore(s('hello world', 11))).toEqual({ value: 'hello ', cursor: 6 })
  })

  it('skips trailing whitespace then deletes the word', () => {
    expect(deleteWordBefore(s('hello world   ', 14))).toEqual({ value: 'hello ', cursor: 6 })
  })

  it('mid-word deletes only back to the word start', () => {
    expect(deleteWordBefore(s('hello world', 8))).toEqual({ value: 'hello rld', cursor: 6 })
  })

  it('deletes the only word entirely', () => {
    expect(deleteWordBefore(s('word', 4))).toEqual({ value: '', cursor: 0 })
  })

  it('no-op at start returns the same state object', () => {
    const st = s('abc', 0)
    expect(deleteWordBefore(st)).toBe(st)
  })

  it('whitespace-only prefix: removes the whitespace run', () => {
    expect(deleteWordBefore(s('   x', 3))).toEqual({ value: 'x', cursor: 0 })
  })
})

describe('deleteToStart (Ctrl+U)', () => {
  it('deletes from line start to cursor', () => {
    expect(deleteToStart(s('hello world', 6))).toEqual({ value: 'world', cursor: 0 })
  })

  it('no-op at start returns the same state object', () => {
    const st = s('abc', 0)
    expect(deleteToStart(st)).toBe(st)
  })

  it('at end of line clears everything', () => {
    expect(deleteToStart(s('abc', 3))).toEqual({ value: '', cursor: 0 })
  })
})

describe('deleteToEnd (Ctrl+K)', () => {
  it('deletes from cursor to end of line', () => {
    expect(deleteToEnd(s('hello world', 5))).toEqual({ value: 'hello', cursor: 5 })
  })

  it('no-op at end returns the same state object', () => {
    const st = s('abc', 3)
    expect(deleteToEnd(st)).toBe(st)
  })

  it('at start clears everything', () => {
    expect(deleteToEnd(s('abc', 0))).toEqual({ value: '', cursor: 0 })
  })
})
