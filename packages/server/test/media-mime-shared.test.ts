import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileRoutes } from '../src/routes/files.js'
import { createWebRoutes } from '../src/routes/web.js'
import { createChannelDb, type ChannelDb } from '../src/db/channel-db.js'
import { insertAccount } from '../src/channels/web/accounts.js'
import { classifyMedia } from '../src/channels/shared/media.js'
import { saveInboundMedia } from '../src/channels/shared/media-store.js'
import type { WebChannel } from '../src/channels/web/handler.js'

/**
 * Contract: every server-side image classification / Content-Type decision
 * reads core's shared table (`@turmind/halo-core` media/mime), not a local copy.
 *
 * The four consumers used to carry four different tables — see the audit's
 * "跨包冗余 #2". The divergences that actually shipped:
 *   - `/api/web/file` served .bmp as octet-stream while `/api/files/download`
 *     served image/bmp (same file, two answers depending on the surface)
 *   - `classifyMedia` (channels) had bmp, `/api/web/file` didn't
 *
 * Mutation check (must fail on revert): delete an entry from core's
 * `PHOTO_MIME_BY_EXT` (e.g. `.bmp`) and rebuild core's dist →
 *   - "serves every shared image ext" goes red on BOTH routes for that ext
 *   - "classifyMedia agrees with the shared table" goes red ('other' ≠ 'image')
 * That is the proof the consumers really read the shared table.
 */

/** Extensions core declares as photos. Kept as a literal list on purpose:
 *  importing IMAGE_EXTS here would make the test tautological (a deleted entry
 *  would shrink both sides and stay green). */
const SHARED_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const
const EXPECTED_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

let ws: string
let db: ChannelDb
let tmp: string
const TOKEN = 'tok-media-mime'

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-media-mime-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  for (const ext of SHARED_IMAGE_EXTS) {
    fs.writeFileSync(path.join(ws, `pic${ext}`), Buffer.from([1, 2, 3]))
  }
  fs.writeFileSync(path.join(ws, 'logo.svg'), '<svg/>')
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'plain')
  db = createChannelDb(path.join(tmp, 'secrets'))
  insertAccount(db, { accountId: 'w1', token: TOKEN, workspacePath: ws, accessLevel: 'full' })
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('GET /files/download?inline=1 Content-Type', () => {
  const app = createFileRoutes()

  it.each(SHARED_IMAGE_EXTS)('serves %s from the shared table', async (ext) => {
    const res = await app.request(`/files/download?path=pic${ext}&projectId=${encodeURIComponent(ws)}&inline=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(EXPECTED_MIME[ext])
  })

  it('serves svg (serve-only image) and keeps its own non-image types', async () => {
    const get = (p: string) => app.request(`/files/download?path=${p}&projectId=${encodeURIComponent(ws)}&inline=1`)
    expect((await get('logo.svg')).headers.get('content-type')).toBe('image/svg+xml')
    // notes.txt has no MIME_MAP entry — unchanged octet-stream fallback.
    expect((await get('notes.txt')).headers.get('content-type')).toBe('application/octet-stream')
  })

  it('non-inline download stays a plain attachment regardless of type', async () => {
    const res = await app.request(`/files/download?path=pic.png&projectId=${encodeURIComponent(ws)}`)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toContain('attachment')
  })
})

describe('GET /api/web/file Content-Type', () => {
  // Built per-test, not at collect time: `db` is only assigned in beforeAll.
  const app = () => createWebRoutes({ db, channel: {} as WebChannel })

  it.each(SHARED_IMAGE_EXTS)('serves %s from the shared table', async (ext) => {
    const res = await app().request(`/web/file?path=pic${ext}&token=${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(EXPECTED_MIME[ext])
  })

  it('keeps its own non-image types and the octet-stream fallback', async () => {
    const get = (p: string) => app().request(`/web/file?path=${p}&token=${TOKEN}`)
    expect((await get('logo.svg')).headers.get('content-type')).toBe('image/svg+xml')
    // .txt is in this route's own list (the admin file route has no txt entry).
    expect((await get('notes.txt')).headers.get('content-type')).toBe('text/plain')
  })
})

describe('classifyMedia', () => {
  it.each(SHARED_IMAGE_EXTS)('classifies %s as image', (ext) => {
    expect(classifyMedia(`/tmp/whatever${ext}`)).toBe('image')
    expect(classifyMedia(`/tmp/UPPER${ext.toUpperCase()}`)).toBe('image')
  })

  it('leaves non-photo formats out of the image class', () => {
    // svg/ico/avif get a Content-Type but must not be sent as a channel photo.
    expect(classifyMedia('/tmp/logo.svg')).toBe('other')
    expect(classifyMedia('/tmp/a.mp4')).toBe('video')
    expect(classifyMedia('/tmp/a.ogg')).toBe('voice')
  })
})

describe('saveInboundMedia filename extension', () => {
  let mediaWs: string

  beforeEach(() => {
    mediaWs = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-media-store-'))
  })

  it('names image files from the shared mime→ext map (jpeg → .jpg)', async () => {
    for (const [mime, ext] of [['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'], ['image/webp', '.webp'], ['image/bmp', '.bmp']]) {
      const saved = await saveInboundMedia({
        workspacePath: mediaWs, accountId: 'acc', channel: 'web',
        buffer: Buffer.from([0x42, 0x4d, 0, 0]), kind: 'image', mimeType: mime,
      })
      expect(path.extname(saved), mime).toBe(ext)
    }
  })

  it('still resolves the non-image types the channels deliver', async () => {
    for (const [mime, ext] of [['video/mp4', '.mp4'], ['audio/ogg', '.ogg'], ['application/pdf', '.pdf']]) {
      const saved = await saveInboundMedia({
        workspacePath: mediaWs, accountId: 'acc', channel: 'web',
        buffer: Buffer.from([1, 2, 3, 4]), kind: 'file', mimeType: mime,
      })
      expect(path.extname(saved), mime).toBe(ext)
    }
  })

  it('serve-only image mimes are NOT named from the table (still byte-sniffed)', async () => {
    // svg/ico/avif get a Content-Type when serving, but an inbound attachment
    // tagged image/svg+xml must not become a `.svg` the file routes then serve
    // inline — core's reverse map is photo-only for exactly this reason.
    const saved = await saveInboundMedia({
      workspacePath: mediaWs, accountId: 'acc', channel: 'web',
      buffer: Buffer.from('<svg/>'), kind: 'file', mimeType: 'image/svg+xml',
    })
    expect(path.extname(saved)).toBe('.bin')
  })

  it('unknown mime falls back to byte sniffing', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const saved = await saveInboundMedia({
      workspacePath: mediaWs, accountId: 'acc', channel: 'web',
      buffer: png, kind: 'image', mimeType: 'image/tiff',
    })
    expect(path.extname(saved)).toBe('.png')
  })
})
