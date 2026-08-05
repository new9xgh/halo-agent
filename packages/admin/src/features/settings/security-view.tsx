'use client'

import { useState } from 'react'
import { LogOut } from 'lucide-react'
import { useI18n } from '@/shared/i18n'
import { cn } from '@/shared/utils'
import { newPasswordIssue } from './password-strength'

/** Security page: change password + log out. */
export function SecurityView() {
  return (
    <div className="space-y-8 p-6">
      <ChangePasswordCard />
      <LogoutCard />
    </div>
  )
}

/**
 * Change the admin login password. Posts to /api/auth/change-password
 * (JWT-cookie authed); the server re-verifies the old password and the
 * strength rule, then rewrites the scrypt hash in ~/.halo/secrets/config.yaml.
 * Existing login cookies stay valid (jwt_secret is not rotated).
 */
function ChangePasswordCard() {
  const { t } = useI18n()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState('')
  const [success, setSuccess] = useState(false)

  const issue = next !== '' ? newPasswordIssue(next) : null
  const sameAsOld = next !== '' && next === current
  const mismatch = confirm !== '' && confirm !== next
  const canSubmit = !submitting && current !== '' && next !== ''
    && confirm === next && issue === null && !sameAsOld

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setServerError('')
    setSuccess(false)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword: current, newPassword: next }),
        credentials: 'include',
      })
      if (res.ok) {
        setSuccess(true)
        setCurrent('')
        setNext('')
        setConfirm('')
      } else {
        // Show the server's reason verbatim — it's the authoritative check.
        const body = await res.json().catch(() => null) as { error?: string } | null
        setServerError(body?.error || `HTTP ${res.status}`)
      }
    } catch {
      setServerError(t('security.changePassword.connectionFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">{t('security.changePassword.title')}</h2>
        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{t('security.changePassword.desc')}</p>
      </div>

      <form onSubmit={handleSubmit} className="max-w-md space-y-4 rounded-md border border-[var(--border)] bg-[var(--card)] p-4">
        <PasswordField
          label={t('security.changePassword.current')}
          value={current}
          disabled={submitting}
          autoComplete="current-password"
          onChange={(v) => { setCurrent(v); setSuccess(false) }}
        />
        <PasswordField
          label={t('security.changePassword.new')}
          value={next}
          disabled={submitting}
          autoComplete="new-password"
          onChange={(v) => { setNext(v); setSuccess(false) }}
          error={issue ? t(`security.changePassword.${issue}`) : sameAsOld ? t('security.changePassword.sameAsOld') : undefined}
          hint={t('security.changePassword.rule')}
        />
        <PasswordField
          label={t('security.changePassword.confirm')}
          value={confirm}
          disabled={submitting}
          autoComplete="new-password"
          onChange={(v) => { setConfirm(v); setSuccess(false) }}
          error={mismatch ? t('security.changePassword.mismatch') : undefined}
        />

        {serverError && <p className="text-[11px] text-red-400">{serverError}</p>}
        {success && <p className="text-[11px] text-emerald-400">{t('security.changePassword.success')}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? t('security.changePassword.submitting') : t('security.changePassword.submit')}
        </button>
      </form>
    </div>
  )
}

/**
 * Log out of the admin on this browser. The login state is an httpOnly JWT
 * cookie — JS can't clear it directly, so we call POST /api/auth/logout
 * (expires the cookie via Set-Cookie) and reload; the auth check on boot
 * then lands on the login page.
 */
function LogoutCard() {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch { /* cookie may still be alive — reload lands back in the app */ }
    window.location.reload()
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">{t('security.logout')}</h2>
        <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{t('security.logout.desc')}</p>
      </div>
      <button
        onClick={handleLogout}
        disabled={busy}
        className="flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-[var(--secondary)] disabled:opacity-50"
      >
        <LogOut className="h-3.5 w-3.5" />
        {t('security.logout')}
      </button>
    </div>
  )
}

function PasswordField({
  label, value, disabled, autoComplete, onChange, error, hint,
}: {
  label: string
  value: string
  disabled: boolean
  autoComplete: string
  onChange: (v: string) => void
  error?: string
  hint?: string
}) {
  return (
    <div>
      <label className="text-xs font-medium text-[var(--foreground)]">{label}</label>
      <input
        type="password"
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'mt-1 h-7 w-full rounded border bg-[var(--background)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]',
          error ? 'border-red-400/60' : 'border-[var(--border)]',
        )}
      />
      {error
        ? <p className="mt-0.5 text-[10px] text-red-400">{error}</p>
        : hint
          ? <p className="mt-0.5 text-[10px] text-[var(--muted-foreground)]">{hint}</p>
          : null}
    </div>
  )
}
