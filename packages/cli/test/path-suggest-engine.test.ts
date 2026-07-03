import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectActiveRef, scanCandidates, applyPathPick } from '../src/tui/path-suggest-engine.js'
import type { PathItem } from '../src/tui/components/path-suggest.js'

/**
 * Contract: the @-path completion loop is detect → scan → pick → (value is
 * re-detected). The output of applyPathPick MUST itself be detectable again
 * when a directory was picked (popup keeps descending) — that closure is what
 * broke in the quoted-dir case (`@file "my dir/` re-picked to `@file@file …`).
 */

const item = (over: Partial<PathItem>): PathItem => ({
  name: over.name ?? 'x',
  insertPath: over.insertPath ?? 'x',
  isDir: over.isDir ?? false,
  isImage: over.isImage ?? false,
})

describe('detectActiveRef', () => {
  it('bare @partial at end of input → file kind', () => {
    expect(detectActiveRef('hello @src')).toEqual({ pathStart: 7, partial: 'src', kind: 'file' })
  })

  it('bare @ with empty partial', () => {
    expect(detectActiveRef('@')).toEqual({ pathStart: 1, partial: '', kind: 'file' })
  })

  it('explicit @file / @image / @scope kinds', () => {
    expect(detectActiveRef('@file src/a')?.kind).toBe('file')
    expect(detectActiveRef('@image pics/')?.kind).toBe('image')
    expect(detectActiveRef('@scope packages/')?.kind).toBe('scope')
  })

  it('quoted partial: `@file "my d` → partial without the quote', () => {
    const ref = detectActiveRef('@file "my d')
    expect(ref?.partial).toBe('my d')
    expect(ref?.kind).toBe('file')
  })

  it('no active ref for plain text / completed refs', () => {
    expect(detectActiveRef('no refs here ')).toBeNull()
    expect(detectActiveRef('@file "done path" ')).toBeNull()
  })

  it('email-like text (no preceding whitespace) is not a ref', () => {
    expect(detectActiveRef('user@example')).toBeNull()
  })
})

describe('scanCandidates', () => {
  let ws: string
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-suggest-'))
    fs.mkdirSync(path.join(ws, 'docs'))
    fs.writeFileSync(path.join(ws, 'readme.md'), 'x')
    fs.writeFileSync(path.join(ws, 'photo.png'), 'x')
    fs.writeFileSync(path.join(ws, '.hidden'), 'x')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('lists dirs first, hides dotfiles', () => {
    const { items } = scanCandidates('', ws, 'file')
    expect(items.map((i) => i.name)).toEqual(['docs', 'photo.png', 'readme.md'])
  })

  it('filters by case-insensitive basename prefix', () => {
    const { items } = scanCandidates('REA', ws, 'file')
    expect(items.map((i) => i.name)).toEqual(['readme.md'])
  })

  it('@image lists only dirs and images', () => {
    const { items } = scanCandidates('', ws, 'image')
    expect(items.map((i) => i.name)).toEqual(['docs', 'photo.png'])
  })

  it('@scope lists only directories', () => {
    const { items } = scanCandidates('', ws, 'scope')
    expect(items.map((i) => i.name)).toEqual(['docs'])
  })

  it('missing dir → empty list, no throw', () => {
    const { items } = scanCandidates('nonexistent/', ws, 'file')
    expect(items).toEqual([])
  })
})

describe('applyPathPick', () => {
  it('rewrites a bare @partial to canonical @file form with trailing space', () => {
    const value = 'hello @rea'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'readme.md', insertPath: 'readme.md' }))
    expect(out).toBe('hello @file readme.md ')
  })

  it('a picked directory stays open with a trailing slash (keeps descending)', () => {
    const value = '@doc'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'docs', insertPath: 'docs', isDir: true }))
    expect(out).toBe('@file docs/')
    // Closure: the result must still be an active ref for the next scan.
    expect(detectActiveRef(out)?.partial).toBe('docs/')
  })

  it('bare pick of an image file normalizes to @image', () => {
    const value = '@pho'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'photo.png', insertPath: 'photo.png', isImage: true }))
    expect(out).toBe('@image photo.png ')
  })

  it('quotes an insertPath containing spaces', () => {
    const value = '@my'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'my dir', insertPath: 'my dir', isDir: true }))
    expect(out).toBe('@file "my dir/')
  })

  it('descending INTO a quoted dir does not double the marker (regression)', () => {
    // Sequence: pick `my dir` → value `@file "my dir/` → pick a child file.
    // The marker-walkback missed the opening quote of an explicit `@file "…`,
    // so the fallback re-derived markerStart past the keyword and produced
    // `@file@file "my dir/notes.txt"`.
    const value = '@file "my dir/'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'notes.txt', insertPath: 'my dir/notes.txt' }))
    expect(out).toBe('@file "my dir/notes.txt" ')
  })

  it('@scope pick keeps the scope kind', () => {
    const value = '@scope pack'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'packages', insertPath: 'packages', isDir: true }))
    expect(out).toBe('@scope packages/')
  })

  it('preserves text before the marker', () => {
    const value = 'check this @file src/'
    const ref = detectActiveRef(value)!
    const out = applyPathPick(value, ref, item({ name: 'a.ts', insertPath: 'src/a.ts' }))
    expect(out).toBe('check this @file src/a.ts ')
  })
})
