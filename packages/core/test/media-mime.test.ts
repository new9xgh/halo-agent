import { describe, it, expect } from 'vitest'
import { IMAGE_EXTS, imageMimeFromExt, extFromImageMime } from '../src/media/mime.js'

/**
 * Contract: one table behind every "is this a picture?" / "what Content-Type?"
 * decision in halo. Six copies used to drift (cli resolve-refs + TUI suggest,
 * server channels/shared/media + media-store, routes/web, routes/files), so
 * the invariants worth locking are the ones a copy got wrong:
 *   - IMAGE_EXTS and imageMimeFromExt agree (derived from the same table)
 *   - photo formats (vision / channel sendPhoto) vs serve-only formats
 *     (svg / ico / avif get a Content-Type but are NOT "images")
 *   - case- and dot-insensitive input (callers pass `.PNG`, `png`, `.png`)
 *   - mime → ext is canonical (image/jpeg → .jpg, never .jpeg)
 *
 * Mutation check: delete any `PHOTO_MIME_BY_EXT` entry → the parity test and
 * that format's row here go red, plus the consumer tests in cli
 * (resolve-refs mime) and server (files/web download Content-Type).
 */
describe('image mime table', () => {
  it('IMAGE_EXTS is exactly the photo formats, dotted and lowercase', () => {
    expect([...IMAGE_EXTS].sort()).toEqual(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp'])
  })

  it('every IMAGE_EXTS member resolves to a mime (set and table cannot drift)', () => {
    for (const ext of IMAGE_EXTS) {
      expect(imageMimeFromExt(ext), ext).toMatch(/^image\//)
    }
  })

  it.each([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.bmp', 'image/bmp'],
  ])('%s → %s', (ext, mime) => {
    expect(imageMimeFromExt(ext)).toBe(mime)
  })

  it('serve-only formats have a mime but are not photos, and do not map back', () => {
    for (const [ext, mime] of [['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'], ['.avif', 'image/avif']]) {
      expect(imageMimeFromExt(ext!)).toBe(mime)
      expect(IMAGE_EXTS.has(ext!)).toBe(false)
      // Reverse direction names inbound media — an inbound "photo" is never svg.
      expect(extFromImageMime(mime!)).toBeUndefined()
    }
  })

  it('accepts bare and upper-case extensions', () => {
    expect(imageMimeFromExt('png')).toBe('image/png')
    expect(imageMimeFromExt('.PNG')).toBe('image/png')
    expect(imageMimeFromExt('JPEG')).toBe('image/jpeg')
  })

  it('returns undefined for non-images — the fallback is the caller\'s', () => {
    expect(imageMimeFromExt('.txt')).toBeUndefined()
    expect(imageMimeFromExt('')).toBeUndefined()
    expect(imageMimeFromExt('.mp4')).toBeUndefined()
  })

  it('mime → canonical ext (jpeg maps to .jpg, not .jpeg)', () => {
    expect(extFromImageMime('image/jpeg')).toBe('.jpg')
    expect(extFromImageMime('image/png')).toBe('.png')
    expect(extFromImageMime('image/webp')).toBe('.webp')
    expect(extFromImageMime('IMAGE/PNG')).toBe('.png')
    expect(extFromImageMime('video/mp4')).toBeUndefined()
  })

  it('ext → mime → ext round-trips for every photo format', () => {
    for (const ext of IMAGE_EXTS) {
      const mime = imageMimeFromExt(ext)!
      // .jpeg collapses onto .jpg (same mime); everything else is 1:1.
      expect(imageMimeFromExt(extFromImageMime(mime)!)).toBe(mime)
    }
  })
})
