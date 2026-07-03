import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveRefs } from '../src/resolve-refs.js'

/**
 * Contract: `@file` / `@image` refs in TUI input become inline <file> blocks /
 * base64 image parts before the message reaches the agent. Missing paths must
 * degrade to visible `[not found: …]` markers — never a throw mid-send.
 */
describe('resolveRefs', () => {
  let ws: string

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-refs-'))
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
  })

  it('passes through text with no refs untouched', () => {
    const out = resolveRefs('just a plain question', ws)
    expect(out.text).toBe('just a plain question')
    expect(out.images).toEqual([])
    expect(out.attachments).toEqual([])
  })

  it('inlines an @file ref as a <file> block with workspace-relative path', () => {
    fs.writeFileSync(path.join(ws, 'notes.txt'), 'file body')
    const out = resolveRefs('look at @file notes.txt please', ws)
    expect(out.text).toContain('<file path="notes.txt">')
    expect(out.text).toContain('file body')
    expect(out.text).toContain('please')
    expect(out.attachments).toEqual(['notes.txt'])
  })

  it('handles quoted paths with spaces', () => {
    fs.mkdirSync(path.join(ws, 'my dir'))
    fs.writeFileSync(path.join(ws, 'my dir', 'a.txt'), 'spaced')
    const out = resolveRefs('@file "my dir/a.txt"', ws)
    expect(out.text).toContain('spaced')
    expect(out.attachments).toEqual(['my dir/a.txt'])
  })

  it('loads an @image ref as base64 with the right mime type', () => {
    // Tiny valid PNG header + data — content doesn't matter, only bytes.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    fs.writeFileSync(path.join(ws, 'pic.png'), bytes)
    const out = resolveRefs('see @image pic.png', ws)
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/png')
    expect(Buffer.from(out.images[0].data, 'base64')).toEqual(bytes)
  })

  it('treats @file with an image extension as an image (auto-detect)', () => {
    fs.writeFileSync(path.join(ws, 'shot.jpg'), Buffer.from([1, 2, 3]))
    const out = resolveRefs('@file shot.jpg', ws)
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/jpeg')
  })

  it('missing path → [not found] marker, no throw', () => {
    const out = resolveRefs('@file nope.txt end', ws)
    expect(out.text).toContain('[not found: nope.txt]')
    expect(out.text).toContain('end')
    expect(out.attachments).toEqual([])
  })

  it('directory path → [not a file] marker', () => {
    fs.mkdirSync(path.join(ws, 'somedir'))
    const out = resolveRefs('@file somedir', ws)
    expect(out.text).toContain('[not a file: somedir]')
  })

  it('truncates an oversized text file and records a warning', () => {
    fs.writeFileSync(path.join(ws, 'big.txt'), 'x'.repeat(150 * 1024))
    const out = resolveRefs('@file big.txt', ws)
    expect(out.text).toContain('[truncated:')
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('truncated')
  })

  it('resolves multiple refs in one message', () => {
    fs.writeFileSync(path.join(ws, 'a.txt'), 'AAA')
    fs.writeFileSync(path.join(ws, 'b.txt'), 'BBB')
    const out = resolveRefs('@file a.txt and @file b.txt', ws)
    expect(out.text).toContain('AAA')
    expect(out.text).toContain('BBB')
    expect(out.attachments).toEqual(['a.txt', 'b.txt'])
  })
})
