import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: POST /auth/change-password re-verifies the current password,
 * enforces the strength rule (≥8 chars, ≥1 letter, ≥1 digit), rejects
 * new === old, and persists the new scrypt hash to
 * `~/.halo/secrets/config.yaml` in the exact format `halo setup` writes —
 * so the next login (and a later `halo setup`) read it unchanged.
 *
 * config.ts / setup-config.ts resolve paths from os.homedir() at module
 * load → redirect HOME to a temp dir BEFORE the dynamic imports.
 *
 * The route itself never sees the auth cookie — authMiddleware guards it
 * (change-password is NOT in PUBLIC_PATHS; pinned below).
 */

let tmpHome: string
let auth: typeof import('../src/middleware/auth.js')
let hash: typeof import('../src/middleware/password-hash.js')
let setupConfig: typeof import('../src/setup-config.js')
let app: ReturnType<typeof import('../src/middleware/auth.js')['createAuthRoutes']>

const OLD_PW = 'oldpass1'

async function changePassword(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request('/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function login(password: string): Promise<number> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  return res.status
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-change-password-'))
  process.env.HOME = tmpHome
  delete process.env.HALO_PASSWORD

  hash = await import('../src/middleware/password-hash.js')
  setupConfig = await import('../src/setup-config.js')
  // jwt_secret is read EAGERLY at config-module load (`systemString`), unlike
  // server.password (a getter). Credentials must exist on disk before the
  // auth module (→ config module) is imported, or every token signs against
  // a missing secret and login 500s.
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(OLD_PW),
    'server.jwt_secret': hash.generateJwtSecret(),
  })
  auth = await import('../src/middleware/auth.js')
  app = auth.createAuthRoutes()
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(async () => {
  // Reset the password hash per test (a success test rewrites it), through
  // the same writer `halo setup` uses. jwt_secret stays as seeded above.
  setupConfig.updateConfigLeaves({
    'server.password': await hash.hashPassword(OLD_PW),
  })
})

describe('POST /auth/change-password', () => {
  it('wrong current password → 401 with a distinct error', async () => {
    const { status, json } = await changePassword({ oldPassword: 'wrong-pw1', newPassword: 'newpass99' })
    expect(status).toBe(401)
    expect(json.error).toBe('Incorrect current password')
    // Stored hash untouched — old password still logs in.
    expect(await login(OLD_PW)).toBe(200)
  })

  it('weak: shorter than 8 → 400 with the specific reason', async () => {
    const { status, json } = await changePassword({ oldPassword: OLD_PW, newPassword: 'abc1' })
    expect(status).toBe(400)
    expect(json.error).toBe('Password must be at least 8 characters')
  })

  it('weak: pure digits → 400 (needs a letter)', async () => {
    const { status, json } = await changePassword({ oldPassword: OLD_PW, newPassword: '12345678' })
    expect(status).toBe(400)
    expect(json.error).toBe('Password must contain at least one letter')
  })

  it('weak: pure letters → 400 (needs a digit)', async () => {
    const { status, json } = await changePassword({ oldPassword: OLD_PW, newPassword: 'abcdefgh' })
    expect(status).toBe(400)
    expect(json.error).toBe('Password must contain at least one digit')
  })

  it('new password === old password → 400', async () => {
    const { status, json } = await changePassword({ oldPassword: OLD_PW, newPassword: OLD_PW })
    expect(status).toBe(400)
    expect(json.error).toBe('New password must differ from the current password')
  })

  it('success: persists the new scrypt hash; old password stops working, new one logs in', async () => {
    const { status, json } = await changePassword({ oldPassword: OLD_PW, newPassword: 'newpass99' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)

    // On-disk format identical to `halo setup`'s writer.
    const stored = setupConfig.readConfigLeaf('server.password')
    expect(typeof stored).toBe('string')
    expect(stored as string).toMatch(/^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await hash.verifyPassword('newpass99', stored as string)).toBe(true)

    // Live behavior without a restart (config.yaml is mtime-watched).
    expect(await login(OLD_PW)).toBe(401)
    expect(await login('newpass99')).toBe(200)
  })

  it('malformed body → 401 (empty old password is just a wrong password)', async () => {
    const res = await app.request('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(401)
  })

  it('is NOT in PUBLIC_PATHS — authMiddleware blocks unauthenticated calls', async () => {
    // Compose the middleware exactly as index.ts does; no cookie → 401
    // before the handler runs (the stored hash must remain unchanged).
    const { Hono } = await import('hono')
    const gated = new Hono()
    gated.use('/api/*', auth.authMiddleware() as never)
    gated.route('/api', auth.createAuthRoutes())

    const before = setupConfig.readConfigLeaf('server.password')
    const res = await gated.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: OLD_PW, newPassword: 'newpass99' }),
    })
    expect(res.status).toBe(401)
    expect((await res.json() as { error?: string }).error).toBe('Unauthorized')
    expect(setupConfig.readConfigLeaf('server.password')).toBe(before)

    // Same composition, with the cookie from a real login → passes the gate.
    const loginRes = await gated.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: OLD_PW }),
    })
    expect(loginRes.status).toBe(200)
    const cookie = loginRes.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const ok = await gated.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie! },
      body: JSON.stringify({ oldPassword: OLD_PW, newPassword: 'newpass99' }),
    })
    expect(ok.status).toBe(200)
  })

  it('HALO_PASSWORD env set → 400 (file rewrite would not take effect)', async () => {
    process.env.HALO_PASSWORD = 'env-secret'
    try {
      const { status, json } = await changePassword({ oldPassword: 'env-secret', newPassword: 'newpass99' })
      expect(status).toBe(400)
      expect(String(json.error)).toContain('HALO_PASSWORD')
    } finally {
      delete process.env.HALO_PASSWORD
    }
  })
})

describe('POST /auth/logout', () => {
  it('expires the cookie; the expired cookie no longer passes authMiddleware', async () => {
    const { Hono } = await import('hono')
    const gated = new Hono()
    gated.use('/api/*', auth.authMiddleware() as never)
    gated.route('/api', auth.createAuthRoutes())
    // A protected probe endpoint behind the same middleware.
    gated.get('/api/probe', (c) => c.json({ ok: true }))

    const loginRes = await gated.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: OLD_PW }),
    })
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]
    expect((await gated.request('/api/probe', { headers: { Cookie: cookie } })).status).toBe(200)

    const logoutRes = await gated.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })
    expect(logoutRes.status).toBe(200)
    // Server instructs the browser to drop the cookie (Max-Age=0, empty value).
    const cleared = logoutRes.headers.get('set-cookie')!
    expect(cleared).toMatch(/halo_token=;/)
    expect(cleared).toMatch(/Max-Age=0/i)

    // Browser honors Max-Age=0 by dropping the cookie → next request is bare.
    expect((await gated.request('/api/probe')).status).toBe(401)
  })
})
