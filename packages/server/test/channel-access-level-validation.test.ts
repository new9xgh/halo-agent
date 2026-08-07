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
 * Contract (audit B-L1): `accessLevel` is validated at the REST boundary on
 * EVERY channel, with one shared whitelist.
 *
 * Before: only wechat's PATCH rejected junk. telegram / slack / feishu / web
 * PATCH wrote any string straight into `channel_accounts.access_level`, and
 * `toAccount` quietly normalized the unknown value back to `readonly` on every
 * read — so the row held a value no code path agreed with, and the admin UI
 * showed a level the account didn't actually have.
 *
 * The one deliberate asymmetry: `observer` (global read-only, minted for
 * halo-city / metrics) is legal on **web only**. It's a dashboard role, not a
 * chat identity — the four chat channels' admin forms offer three values and
 * chat-side routing collapses observer to readonly anyway (see commit 5f025d1).
 * So chat channels reject it at the boundary rather than storing a level their
 * own routing won't honor.
 *
 * PATCH is asserted through the real route handlers against a real sqlite row,
 * checking the STORED value — a 400 that still wrote is the actual bug.
 *
 * Mutation check (must fail on revert): drop any route's `accessLevelError`
 * call → that channel's "rejects illegal value" case goes red on the status
 * AND on the stored level.
 */

const ILLEGAL = ['admin', 'FULL', 'readonly ', 'root', '', 'workspace;--']

let tmp: string
let ws: string
let db: ChannelDb

/** Every channel interface is start/stop only (web is generator-based and
 *  untouched by CRUD), so no-op stubs exercise the real route logic. */
const chanStub = { startAccount: () => {}, stopAccount: async () => {}, stopAll: async () => {} }
const webStub = {} as WebChannel

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-access-level-'))
  ws = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(ws, '.halo'), { recursive: true })
  db = createChannelDb(path.join(tmp, 'secrets'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Read the raw stored value — not the `toAccount`-normalized view, which
 *  would mask a junk write by mapping it back to 'readonly'. */
function storedLevel(accountId: string): string | undefined {
  return db.select().from(channelAccounts).all()
    .find((r) => r.accountId === accountId)?.accessLevel
}

function seed(accountId: string, channelType: string): void {
  insertAccount(db, {
    accountId, channelType, workspacePath: ws,
    label: 'seed', accessLevel: 'workspace', config: { token: `tok-${accountId}` },
  })
}

// PATCH surface of all five channels: {route factory, path, seeded channelType}.
const CHANNELS = [
  { name: 'web', channelType: 'web', accountId: 'web1', app: () => createWebRoutes({ db, channel: webStub }), url: (id: string) => `/web/accounts/${id}` },
  { name: 'telegram', channelType: 'telegram', accountId: 'tgbot', app: () => createTelegramRoutes({ db, channel: chanStub as TelegramChannel }), url: (id: string) => `/telegram/accounts/${id}` },
  { name: 'slack', channelType: 'slack', accountId: 't0team', app: () => createSlackRoutes({ db, channel: chanStub as SlackChannel }), url: (id: string) => `/slack/accounts/${id}` },
  { name: 'feishu', channelType: 'feishu', accountId: 'cli_app', app: () => createFeishuRoutes({ db, channel: chanStub as FeishuChannel }), url: (id: string) => `/feishu/accounts/${id}` },
  { name: 'wechat', channelType: 'wechat', accountId: 'wx-bot', app: () => createWechatRoutes({ db, channel: chanStub as WechatChannel }), url: (id: string) => `/wechat/accounts/${id}` },
] as const

function patch(app: ReturnType<(typeof CHANNELS)[number]['app']>, url: string, body: unknown) {
  return app.request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe.each(CHANNELS)('PATCH /$name accounts — accessLevel whitelist', ({ channelType, accountId, app, url }) => {
  it('rejects illegal values with 400 and stores nothing', async () => {
    for (const bad of ILLEGAL) {
      seed(accountId, channelType)
      const res = await patch(app(), url(accountId), { accessLevel: bad })
      expect(res.status, `${bad || '<empty>'} should be rejected`).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('accessLevel') })
      // The row must be untouched — a 400 that still wrote is the real bug.
      expect(storedLevel(accountId), `${bad || '<empty>'} must not be stored`).toBe('workspace')
      db.delete(channelAccounts).run()
    }
  })

  it('accepts the three chat-legal values and stores them', async () => {
    for (const good of ['full', 'workspace', 'readonly']) {
      seed(accountId, channelType)
      const res = await patch(app(), url(accountId), { accessLevel: good })
      expect(res.status, good).toBe(200)
      expect(storedLevel(accountId), good).toBe(good)
      db.delete(channelAccounts).run()
    }
  })

  it('leaves the stored level alone when accessLevel is absent', async () => {
    seed(accountId, channelType)
    const res = await patch(app(), url(accountId), { label: 'renamed' })
    expect(res.status).toBe(200)
    expect(storedLevel(accountId)).toBe('workspace')
  })

  it('404s on an unknown account without validating', async () => {
    const res = await patch(app(), url('nope'), { accessLevel: 'full' })
    expect(res.status).toBe(404)
  })
})

describe('observer is web-only', () => {
  it('web PATCH accepts observer (halo-city / metrics tokens live here)', async () => {
    seed('web1', 'web')
    const res = await patch(createWebRoutes({ db, channel: webStub }), '/web/accounts/web1', { accessLevel: 'observer' })
    expect(res.status).toBe(200)
    expect(storedLevel('web1')).toBe('observer')
  })

  it.each(CHANNELS.filter((c) => c.name !== 'web'))('$name PATCH rejects observer', async ({ channelType, accountId, app, url }) => {
    seed(accountId, channelType)
    const res = await patch(app(), url(accountId), { accessLevel: 'observer' })
    expect(res.status).toBe(400)
    expect(storedLevel(accountId)).toBe('workspace')
  })
})

describe('POST /web/accounts — accessLevel whitelist', () => {
  it('rejects an illegal value before creating the account', async () => {
    const res = await createWebRoutes({ db, channel: webStub })
      .request('/web/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: ws, accessLevel: 'admin' }),
      })
    expect(res.status).toBe(400)
    expect(db.select().from(channelAccounts).all()).toHaveLength(0)
  })

  it('accepts observer and persists it', async () => {
    const res = await createWebRoutes({ db, channel: webStub })
      .request('/web/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacePath: ws, accessLevel: 'observer' }),
      })
    expect(res.status).toBe(200)
    const { accountId } = await res.json() as { accountId: string }
    expect(storedLevel(accountId)).toBe('observer')
  })
})
