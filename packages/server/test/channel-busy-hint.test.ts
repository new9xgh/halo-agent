import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/agents/session-manager.js'
import { busyHint } from '../src/channels/shared/busy-hint.js'
import { t } from '../src/channels/shared/i18n.js'
import { agentSessions } from '../src/db/schema.js'

/**
 * Regression: a message sent to an IM channel WHILE the session was compacting
 * was answered with "please wait" and then dropped — the four channel handlers
 * had an extra `return` in their compacting branch, so it never reached
 * `sendUserMessage` and never entered the queue. The mid-turn branch right below
 * it (no `return`) was correct, which is what made the bug invisible in review.
 *
 * Two layers pinned here:
 *  1. `busyHint` returns TEXT (or null) and nothing else — a caller cannot learn
 *     "stop processing" from it, which is structurally why the `return` can't
 *     come back. All four channels now go through it.
 *  2. `sendUserMessage` on a compacting session really does queue the message —
 *     i.e. the channel's job is only the hint, and delivering unconditionally is
 *     safe.
 *
 * Not driven through the real channel handlers: `handleTextMessage` /
 * `handleInbound` are module-private and would need the WeChat CDN, Telegram
 * grammY ctx, Slack Web API and Feishu ws client all mocked to reach these four
 * lines. The shared helper is the single point they now share, and layer 2 uses
 * the real SessionManager, so the invariant is covered without reshaping
 * production code for testability.
 */

let ws: string
let sm: SessionManager

function seedRow(id: string): void {
  sm.getDb().insert(agentSessions).values({
    id, parentId: null, agentId: 'default', agentName: 'Default',
    description: '', workingDir: null, accessLevel: null,
    createdAt: 1000, updatedAt: 1000, stoppedAt: null, archivedAt: null,
  }).run()
}

/** Minimal in-memory session in the state under test. `promise` non-null =
 *  mid-turn; `isCompacting` = compacting. Same seeding approach as
 *  queue-semantics.test.ts — we only touch queue/flag fields, never run a turn. */
function fakeSession(id: string, state: { isCompacting?: boolean; busy?: boolean }) {
  const session = {
    id,
    agentId: 'default',
    parentId: null,
    accessLevel: null,
    agent: { messages: [] as unknown[] },
    promise: state.busy ? new Promise<string>(() => {}) : null,
    abortController: state.busy ? new AbortController() : null,
    messageQueue: [] as Array<{ text: string; images?: unknown }>,
    interruptRequested: false,
    isCompacting: state.isCompacting ?? false,
    compactAbortController: null,
    supportsImage: false,
  }
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, session)
  return session
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-busy-hint-'))
  sm = new SessionManager(ws)
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('busyHint', () => {
  it('returns a hint while compacting — never a signal to stop processing', () => {
    seedRow('wx_u1_a')
    fakeSession('wx_u1_a', { isCompacting: true })
    const hint = busyHint(sm, 'wx_u1_a', 'en')
    expect(typeof hint).toBe('string')
    // The copy must not tell the user to re-send: the message IS queued, so
    // "send again later" makes them duplicate it (the pre-fix wording did).
    expect(hint!.toLowerCase()).not.toMatch(/please wait|send again|再发/)
    expect(busyHint(sm, 'wx_u1_a', 'zh')).toContain('已收到')
  })

  it('returns the queued hint mid-turn', () => {
    seedRow('wx_u2_a')
    fakeSession('wx_u2_a', { busy: true })
    expect(busyHint(sm, 'wx_u2_a', 'en')).toBeTruthy()
  })

  it('returns null when idle (nothing to send)', () => {
    seedRow('wx_u3_a')
    fakeSession('wx_u3_a', {})
    expect(busyHint(sm, 'wx_u3_a', 'en')).toBeNull()
  })

  it('compacting takes precedence over busy (both flags set)', () => {
    seedRow('wx_u4_a')
    fakeSession('wx_u4_a', { isCompacting: true, busy: true })
    seedRow('wx_u4_b')
    fakeSession('wx_u4_b', { busy: true })
    // A compact happens mid-turn, so both flags are set in reality — the user
    // should hear about the compact (the 30s wait), not the generic queue.
    expect(busyHint(sm, 'wx_u4_a', 'zh')).toContain('整理上下文')
    expect(busyHint(sm, 'wx_u4_a', 'en')).not.toBe(busyHint(sm, 'wx_u4_b', 'en'))
  })
})

describe('a message sent during a compact is queued, not dropped', () => {
  it('sendUserMessage queues while compacting (the delivery the channels skipped)', async () => {
    seedRow('wx_u5_a')
    const session = fakeSession('wx_u5_a', { isCompacting: true })

    const result = await sm.sendUserMessage('wx_u5_a', 'msg during compact')

    expect(result).toBe('queued')
    expect(session.messageQueue).toHaveLength(1)
    expect(session.messageQueue[0]!.text).toBe('msg during compact')
  })

  it('endCompact drains what arrived during the compact', () => {
    seedRow('wx_u6_a')
    const session = fakeSession('wx_u6_a', { isCompacting: true })
    session.messageQueue.push({ text: 'queued mid-compact' })

    let drained: string | null = null
    // runSession('') = "work is already in messageQueue" (the drain entry point).
    ;(sm as unknown as { runSession: (id: string, m: string) => Promise<string> }).runSession =
      async (id, m) => { drained = `${id}:${m}`; return '' }

    sm.endCompact('wx_u6_a')

    expect(session.isCompacting).toBe(false)
    expect(drained).toBe('wx_u6_a:')
  })

  it('mid-turn still queues too (the branch that was already correct)', async () => {
    seedRow('wx_u7_a')
    const session = fakeSession('wx_u7_a', { busy: true })

    const result = await sm.sendUserMessage('wx_u7_a', 'msg mid turn')

    expect(result).toBe('queued')
    expect(session.messageQueue).toHaveLength(1)
    expect(session.interruptRequested).toBe(true)
  })
})

/**
 * Same class of bug on the outbound side: the "upload failed" reply was
 * hardcoded — always Chinese in feishu, always English in slack — so an account
 * with `language='en'` got Chinese and vice versa. Both now go through
 * `handler.upload_failed` with `getLang(account)`.
 */
describe('handler.upload_failed', () => {
  it('renders in both languages with the filename and reason filled in', () => {
    for (const lang of ['zh', 'en'] as const) {
      const text = t('handler.upload_failed', lang, { name: 'report.pdf', error: 'file_too_large' })
      expect(text).toContain('report.pdf')
      expect(text).toContain('file_too_large')
      // A missing key falls back to the key itself, and an unknown param is
      // left as `{name}` — both would silently ship to the user.
      expect(text).not.toBe('handler.upload_failed')
      expect(text).not.toMatch(/\{\w+\}/)
    }
  })

  it('differs between zh and en (neither side is hardcoded any more)', () => {
    const args = { name: 'a.png', error: 'timeout' }
    expect(t('handler.upload_failed', 'zh', args)).not.toBe(t('handler.upload_failed', 'en', args))
  })
})
