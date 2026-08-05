/** Client-side mirror of the server's strength rule (middleware/auth.ts
 *  passwordStrengthError): ≥8 chars, at least one letter and one digit.
 *  Server stays authoritative — this only powers live feedback. */
export function newPasswordIssue(pw: string): 'tooShort' | 'needLetter' | 'needDigit' | null {
  if (pw.length < 8) return 'tooShort'
  if (!/[A-Za-z]/.test(pw)) return 'needLetter'
  if (!/[0-9]/.test(pw)) return 'needDigit'
  return null
}
