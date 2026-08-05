'use client'

import { useEffect, useState } from 'react'

/**
 * JSON-endpoint sibling of use-preview-fetch: run an abortable async fetcher,
 * return {data, error, loading}. Used by previews that parse server-side
 * (sqlite / parquet) instead of downloading raw bytes.
 *
 * Pass `null` as the fetcher to stay idle (e.g. sqlite rows before a table
 * is selected).
 */
export function useDataFetch<T>(
  fetcher: ((signal: AbortSignal) => Promise<T>) | null,
  deps: React.DependencyList,
): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!fetcher)

  useEffect(() => {
    if (!fetcher) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const ac = new AbortController()
    setLoading(true)
    setError(null)

    fetcher(ac.signal)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        setError(extractApiError(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
      ac.abort()
    }
  }, deps)

  return { data, error, loading }
}

/** api-client throws `API error 400: {"error":"..."}` — surface just the message. */
function extractApiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const jsonStart = msg.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(msg.slice(jsonStart)) as { error?: string }
      if (parsed.error) return parsed.error
    } catch { /* not JSON — fall through to raw message */ }
  }
  return msg
}
