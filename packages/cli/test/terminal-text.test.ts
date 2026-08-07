import { describe, it, expect } from 'vitest'
import { sanitizeToolOutput, tailByRows } from '../src/tui/terminal-text.js'

/**
 * Contract (audit E-H2 / E-L7 / E-M2): text arriving from outside the TUI is
 * never trusted to be benign single-width ASCII.
 *
 *   1. sanitizeToolOutput leaves NO C0 control byte other than `\n` — a `\r`
 *      from a pip/npm progress bar would otherwise rewind the terminal cursor
 *      to column 0 and overwrite the block's `│ ` gutter, permanently, since
 *      these blocks live in <Static>.
 *   2. tailByRows bounds the live (non-Static) zone by *rendered rows*, which
 *      is what decides whether ink falls back to clearTerminal (= ESC 3J =
 *      scrollback wiped) on every streamed token.
 */

describe('sanitizeToolOutput', () => {
  it('folds CR and CRLF into a single newline', () => {
    expect(sanitizeToolOutput('a\rb')).toBe('a\nb')
    expect(sanitizeToolOutput('a\r\nb')).toBe('a\nb')
    expect(sanitizeToolOutput('a\n\rb')).toBe('a\n\nb')
  })

  it('drops every other C0 control char (BS, BEL, VT, FF, NUL, DEL)', () => {
    const out = sanitizeToolOutput('a\bb\x07c\x0bd\x0ce\x00f\x7fg')
    expect(out).toBe('abcdefg')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x09\x0b-\x1f\x7f]/.test(out)).toBe(false)
  })

  it('keeps newlines and printable text (including CJK / emoji) intact', () => {
    expect(sanitizeToolOutput('第一行\n🎯 second\n')).toBe('第一行\n🎯 second\n')
  })

  it('expands tabs to two spaces — ink measures string width, the terminal uses 8-column tab stops', () => {
    expect(sanitizeToolOutput('col1\tcol2')).toBe('col1  col2')
  })

  it('strips SGR colors so foreign escapes cannot end the block dim mid-line (E-L7)', () => {
    expect(sanitizeToolOutput('\x1b[31mred\x1b[0m plain')).toBe('red plain')
    expect(sanitizeToolOutput('\x1b[1;38;5;204mfancy\x1b[m')).toBe('fancy')
  })

  it('strips non-SGR CSI + OSC (clear-screen, set-title) without leaving parameter bytes', () => {
    expect(sanitizeToolOutput('before\x1b[2Jafter')).toBe('beforeafter')
    expect(sanitizeToolOutput('a\x1b]0;pwned\x07b')).toBe('ab')
    expect(sanitizeToolOutput('x\x1b[?25ly')).toBe('xy')
  })

  it('a real progress-bar sequence becomes one line per redraw frame', () => {
    const pip = 'Downloading pkg\r  10% |##        |\r  99% |######### |\r 100% |##########|\nDone\n'
    expect(sanitizeToolOutput(pip).split('\n')).toEqual([
      'Downloading pkg',
      '  10% |##        |',
      '  99% |######### |',
      ' 100% |##########|',
      'Done',
      '',
    ])
  })

  it('is a no-op on already-clean text (identity, so nothing churns)', () => {
    const clean = 'line one\nline two\n'
    expect(sanitizeToolOutput(clean)).toBe(clean)
  })
})

describe('tailByRows', () => {
  it('returns the text unchanged when it fits the row budget', () => {
    expect(tailByRows('a\nb\nc', 80, 10)).toBe('a\nb\nc')
  })

  it('keeps only the last N hard lines', () => {
    const text = ['1', '2', '3', '4', '5'].join('\n')
    expect(tailByRows(text, 80, 2)).toBe('4\n5')
  })

  it('counts soft-wrapped rows, not just newlines', () => {
    // 3 lines of 20 cols at width 10 = 6 rendered rows; a 2-row budget keeps
    // only the final wrapped line's worth.
    const text = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join('\n')
    const out = tailByRows(text, 10, 2)
    expect(out.includes('b')).toBe(false)
    expect(out).toBe('c'.repeat(20))
  })

  it('counts CJK as two columns when measuring wrap', () => {
    // 10 CJK chars = 20 columns = 2 rows at width 10; a 1-row budget halves it.
    const out = tailByRows('中'.repeat(10), 10, 1)
    expect(out.length).toBeLessThan(10)
  })

  it('never cuts inside a surrogate pair', () => {
    const out = tailByRows('🎯'.repeat(40), 10, 1)
    expect(out.isWellFormed()).toBe(true)
  })

  it('is bounded by the row budget, not the text length (hot path: every token)', () => {
    const huge = 'x'.repeat(2_000_000)
    const t0 = performance.now()
    const out = tailByRows(huge, 80, 12)
    const ms = performance.now() - t0
    expect(out.length).toBeLessThanOrEqual(80 * 13)
    expect(ms).toBeLessThan(50)
  })
})
