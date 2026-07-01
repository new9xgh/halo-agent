import { useState, useEffect, useCallback } from 'react'

const KEY = 'halo_recent_workspaces'
const MAX = 8

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function write(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* ignore */
  }
}

// Move `path` to the front (most-recently-used), dedupe, cap at MAX. Called only
// after a workspace switch validates the path, so invalid entries never land here.
export function addRecentWorkspace(path: string) {
  const list = read().filter((p) => p !== path)
  list.unshift(path)
  write(list.slice(0, MAX))
}

// Reactive view for the dropdown: the current MRU list + a remove-one action.
export function useRecentWorkspaces() {
  const [recent, setRecent] = useState<string[]>([])
  useEffect(() => {
    setRecent(read())
  }, [])
  const remove = useCallback((path: string) => {
    setRecent((prev) => {
      const next = prev.filter((p) => p !== path)
      write(next)
      return next
    })
  }, [])
  return { recent, remove }
}
