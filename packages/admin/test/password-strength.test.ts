import { describe, it, expect } from 'vitest'
import { newPasswordIssue } from '../src/features/settings/password-strength'

/**
 * Contract: the client-side strength check mirrors the server rule
 * (packages/server/src/middleware/auth.ts passwordStrengthError) — ≥8 chars,
 * at least one letter and one digit. If they drift, the form either blocks
 * passwords the server would accept or submits ones it rejects.
 */
describe('newPasswordIssue', () => {
  it('shorter than 8 → tooShort', () => {
    expect(newPasswordIssue('abc1')).toBe('tooShort')
    expect(newPasswordIssue('abcd123')).toBe('tooShort')
  })

  it('pure digits → needLetter', () => {
    expect(newPasswordIssue('12345678')).toBe('needLetter')
  })

  it('pure letters → needDigit', () => {
    expect(newPasswordIssue('abcdefgh')).toBe('needDigit')
  })

  it('8+ chars with letter and digit → null', () => {
    expect(newPasswordIssue('abcdefg1')).toBeNull()
    expect(newPasswordIssue('P@ssw0rd!')).toBeNull()
  })
})
