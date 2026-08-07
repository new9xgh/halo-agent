import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChannelDb, channelAccounts, type ChannelDb } from '../src/db/channel-db.js'
import { createWebRoutes } from '../src/routes/web.js'
import { createTelegramRoutes } from '../src/routes/telegram.js'
import { createSlackRoutes } from '../src/routes/slack.js'
import { createFeishuRoutes } from '../src/routes/feishu.js'
import { createWechatRoutes } from '../src/routes/wechat.js'
import { insertAccount } from '../src/channels/shared/accounts.js'
import type { WebChannel } from '../src/channels/web/handler.js'
import type { TelegramChannel } from '../src/channels/telegram/handler.js'
import type { SlackChannel } from '../src/channels/slack/handler.js'
import type { FeishuChannel } from '../src/channels/feishu/handler.js'
import type { WechatChannel } from '../src/channels/wechat/handler.js'

/**
 * Contract (audit B hotspot #2): a `workspacePath` a channel is about to bind
 * an account to goes through ONE shared check — `validateWorkspaceBody` —
 * on all ten call sites (POST + PATCH × 5 channels): absolute, exists, and
 * `.halo/` scaffolded on success.
 *
 * Before, each site carried its own copy and they had drifted: web /
 * telegram / slack / feishu PATCH never checked `isAbsolute` at all, so a
 * relative path was stored verbatim and later resolved against whatever CWD
 * the server happened to be started in.
 *
 * Two deliberate asymmetries the tests pin rather than paper over:
 *  - Field *presence* stays per-handler: POST requires it, PATCH treats
 *    absence as "leave the binding alone".
 *  - wechat's POST is `/wechat/login/wait`, which blocks on a QR scan. It
 *    checks absolute-ness up front (reject a typo before asking the user to
 *    scan) and defers existence + scaffolding until the scan lands, so an
 *    abandoned login can't scaffold a directory.
 *
 * Mutation check (must fail on revert): drop any route's
 * `validateWorkspaceBody` call → that channel's relative/missing cases go red
 * on the status AND on the stored path.
 */

let tmp: string
let ws: string
let db: ChannelDb

/** Every channel interface used by CRUD is start/stop only (web is
 *  generator-based and untouched here), so no-op stubs exercise real routes. */
const chanStub = { startAccount: () => {}, stopAccount: async () => {}, stopAll: async () => {} }
const webStub = {} as WebChannel

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-ws-validation-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(ws, { recursive: true })
  db = createChannelDb(path.join(tmp, 'secrets'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function storedPath(accountId: string): string | undefined {
  return db.select().from(channelAccounts).all()
    .find((r) => r.accountId === accountId)?.workspacePath
}

function seed(accountId: string, channelType: string): void {
  insertAccount(db, {
    accountId, channelType, workspacePath: ws,
    label: 'seed', accessLevel: 'workspace', config: { token: `tok-${accountId}` },
  })
}

/** Illegal shapes every call site must reject, with the error each maps to.
 *  `''` and `'.'` are the two that used to slip through the four PATCHes:
 *  falsy / relative but harmless-looking. */
const RELATIVE = ['relative/workspace', './workspace', '.', '..', '']

const CHANNELS = [
  {
    name: 'web', channelType: 'web', accountId: 'web1',
    app: () => createWebRoutes({ db, channel: webStub }),
    postUrl: '/web/accounts',
    postBody: (workspacePath: unknown) => ({ workspacePath }),
    url: (id: string) => `/web/accounts/${id}`,
  },
  {
    name: 'telegram', channelType: 'telegram', accountId: 'tgbot',
    app: () => createTelegramRoutes({ db, channel: chanStub as TelegramChannel }),
    postUrl: '/telegram/accounts',
    postBody: (workspacePath: unknown) => ({ botToken: '123:abc', workspacePath }),
    url: (id: string) => `/telegram/accounts/${id}`,
  },
  {
    name: 'slack', channelType: 'slack', accountId: 't0team',
    app: () => createSlackRoutes({ db, channel: chanStub as SlackChannel }),
    postUrl: '/slack/accounts',
    postBody: (workspacePath: unknown) => ({ botToken: 'xoxb-1', appToken: 'xapp-1', workspacePath }),
    url: (id: string) => `/slack/accounts/${id}`,
  },
  {
    name: 'feishu', channelType: 'feishu', accountId: 'cli_app',
    app: () => createFeishuRoutes({ db, channel: chanStub as FeishuChannel }),
    postUrl: '/feishu/accounts',
    postBody: (workspacePath: unknown) => ({ appId: 'cli_app', appSecret: 's', workspacePath }),
    url: (id: string) => `/feishu/accounts/${id}`,
  },
  {
    name: 'wechat', channelType: 'wechat', accountId: 'wx-bot',
    app: () => createWechatRoutes({ db, channel: chanStub as WechatChannel }),
    postUrl: '/wechat/login/wait',
    postBody: (workspacePath: unknown) => ({ sessionKey: 'k', workspacePath }),
    url: (id: string) => `/wechat/accounts/${id}`,
  },
] as const

type Channel = (typeof CHANNELS)[number]

function send(app: ReturnType<Channel['app']>, url: string, method: 'POST' | 'PATCH', body: unknown) {
  return app.request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe.each(CHANNELS)('PATCH /$name accounts — workspacePath validation', ({ channelType, accountId, app, url }) => {
  it.each(RELATIVE)('rejects the relative path %j and stores nothing', async (bad) => {
    seed(accountId, channelType)
    const res = await send(app(), url(accountId), 'PATCH', { workspacePath: bad })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'workspacePath must be absolute' })
    // A 400 that still wrote is the actual bug.
    expect(storedPath(accountId)).toBe(ws)
  })

  it('rejects an absolute path that does not exist and stores nothing', async () => {
    seed(accountId, channelType)
    const missing = path.join(tmp, 'no-such-workspace')
    const res = await send(app(), url(accountId), 'PATCH', { workspacePath: missing })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'workspace path not found' })
    expect(storedPath(accountId)).toBe(ws)
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('leaves the binding alone when workspacePath is absent', async () => {
    seed(accountId, channelType)
    const res = await send(app(), url(accountId), 'PATCH', { label: 'renamed' })
    expect(res.status).toBe(200)
    expect(storedPath(accountId)).toBe(ws)
  })

  it('accepts an existing absolute path and scaffolds .halo/', async () => {
    seed(accountId, channelType)
    const fresh = path.join(tmp, 'fresh')
    fs.mkdirSync(fresh)
    const res = await send(app(), url(accountId), 'PATCH', { workspacePath: fresh })
    expect(res.status).toBe(200)
    expect(storedPath(accountId)).toBe(fresh)
    expect(fs.existsSync(path.join(fresh, '.halo', 'sessions'))).toBe(true)
  })
})

describe.each(CHANNELS)('POST /$name — workspacePath validation', ({ app, postUrl, postBody }) => {
  it('requires the field', async () => {
    const res = await send(app(), postUrl, 'POST', postBody(undefined))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'workspacePath required' })
    expect(db.select().from(channelAccounts).all()).toHaveLength(0)
  })

  it.each(RELATIVE)('rejects the relative path %j before creating anything', async (bad) => {
    const res = await send(app(), postUrl, 'POST', postBody(bad))
    expect(res.status).toBe(400)
    const expected = bad === '' ? 'workspacePath required' : 'workspacePath must be absolute'
    expect(await res.json()).toMatchObject({ error: expected })
    expect(db.select().from(channelAccounts).all()).toHaveLength(0)
  })
})

// The four non-wechat POSTs reject a missing path before touching their
// provider API (getMe / auth.test / bot info), so no network stub is needed.
describe.each(CHANNELS.filter((c) => c.name !== 'wechat'))('POST /$name — missing path', ({ app, postUrl, postBody }) => {
  it('rejects an absolute path that does not exist, without scaffolding it', async () => {
    const missing = path.join(tmp, 'no-such-workspace')
    const res = await send(app(), postUrl, 'POST', postBody(missing))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'workspace path not found' })
    expect(fs.existsSync(missing)).toBe(false)
    expect(db.select().from(channelAccounts).all()).toHaveLength(0)
  })
})

describe('POST /wechat/login/wait defers existence to after the scan', () => {
  it('reports "no login in progress" rather than 400 for a missing path', async () => {
    // The absolute-path check already ran (covered above); existence is only
    // reached once a scan succeeds, so an unknown sessionKey short-circuits
    // first. This asymmetry is intentional — see the file header.
    const res = await send(
      createWechatRoutes({ db, channel: chanStub as WechatChannel }),
      '/wechat/login/wait', 'POST',
      { sessionKey: 'no-such-login', workspacePath: path.join(tmp, 'no-such-workspace') },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ connected: false })
    expect(fs.existsSync(path.join(tmp, 'no-such-workspace'))).toBe(false)
  })
})
