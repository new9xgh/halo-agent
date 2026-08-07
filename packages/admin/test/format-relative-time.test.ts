import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatRelativeTime } from '../src/shared/utils'

/**
 * Contract: one shared relative-time implementation (shared/utils) behind
 * every "{n}m ago" label. Without `t` it renders the English literals
 * (compat with the old session-list-dropdown timeAgo); with `t` it delegates
 * to the `time.*` i18n keys so Chinese UIs stop showing English timestamps.
 * Beyond 30 days it switches to an absolute locale date.
 */

const NOW = new Date('2026-08-06T12:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('formatRelativeTime (English fallback, no t)', () => {
  it('renders "just now" under a minute', () => {
    expect(formatRelativeTime(NOW)).toBe('just now')
    expect(formatRelativeTime(NOW - 59_000)).toBe('just now')
  })

  it('renders minutes under an hour', () => {
    expect(formatRelativeTime(NOW - 60_000)).toBe('1m ago')
    expect(formatRelativeTime(NOW - 59 * 60_000)).toBe('59m ago')
  })

  it('renders hours under a day', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000)).toBe('1h ago')
    expect(formatRelativeTime(NOW - 23 * 60 * 60_000)).toBe('23h ago')
  })

  it('renders days under 30 days', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000)).toBe('1d ago')
    expect(formatRelativeTime(NOW - 29 * 24 * 60 * 60_000)).toBe('29d ago')
  })

  it('falls back to an absolute locale date at 30+ days', () => {
    const old = NOW - 31 * 24 * 60 * 60_000
    expect(formatRelativeTime(old)).toBe(new Date(old).toLocaleDateString())
  })

  it('accepts ISO string dates (SessionMeta.updatedAt legacy shape)', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString()
    expect(formatRelativeTime(iso)).toBe('5m ago')
  })
})

describe('formatRelativeTime (i18n path)', () => {
  // Minimal `t` that mirrors i18n context's key→template+params behavior.
  const zh: Record<string, string> = {
    'time.justNow': '刚刚',
    'time.minutes': '{n} 分钟前',
    'time.hours': '{n} 小时前',
    'time.days': '{n} 天前',
  }
  const t = (key: string, params?: Record<string, string | number>) => {
    let text = zh[key] ?? key
    for (const [k, v] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }

  it('routes each bucket through the time.* keys', () => {
    expect(formatRelativeTime(NOW, t)).toBe('刚刚')
    expect(formatRelativeTime(NOW - 5 * 60_000, t)).toBe('5 分钟前')
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, t)).toBe('3 小时前')
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, t)).toBe('2 天前')
  })

  it('still uses the absolute locale date at 30+ days (no key)', () => {
    const old = NOW - 45 * 24 * 60 * 60_000
    expect(formatRelativeTime(old, t)).toBe(new Date(old).toLocaleDateString())
  })
})
