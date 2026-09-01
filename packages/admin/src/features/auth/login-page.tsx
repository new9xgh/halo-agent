'use client'

import { useState, useCallback } from 'react'
import { useT } from '@/shared/i18n'

interface LoginPageProps {
  onSuccess: () => void
}

export function LoginPage({ onSuccess }: LoginPageProps) {
  const t = useT()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!password.trim()) return

      setLoading(true)
      setError('')

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: password.trim() }),
          credentials: 'include',
        })

        if (res.ok) {
          onSuccess()
        } else {
          setError(t('login.incorrectPassword'))
          setPassword('')
        }
      } catch {
        setError(t('login.connectionFailed'))
      } finally {
        setLoading(false)
      }
    },
    [password, onSuccess, t],
  )

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[var(--background)]">
      <div className="w-full max-w-sm px-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--secondary)]">
            <img src="/icon.png" alt={t('login.brand')} className="h-9 w-9" />
          </div>
          <h1 className="text-xl font-semibold text-[var(--foreground)]">{t('login.brand')}</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">{t('login.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-8">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('login.password')}
            autoFocus
            className="w-full rounded-md border border-[var(--border)] bg-[var(--secondary)] px-3 py-2.5 text-sm text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]"
          />
          {error && (
            <p className="mt-2 text-xs text-red-400">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !password.trim()}
            className="mt-4 w-full rounded-md bg-[var(--primary)] px-3 py-2.5 text-sm font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {loading ? t('login.verifying') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  )
}
