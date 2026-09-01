'use client'

import { useState, useRef, useEffect } from 'react'
import { Trash2, Pencil, Loader2 } from 'lucide-react'
import { useProjectStore } from '@/shared/stores/project-store'
import { useSessionList } from '@/shared/use-session-list'
import { SessionHistoryLink } from '@/shared/components/session-list-dropdown'
import type { SessionMeta } from '@/shared/components/session-list-dropdown'
import { api } from '@/shared/api-client'
import { bumpSessionBus } from '@/shared/session-bus'
import { cn, formatRelativeTime } from '@/shared/utils'
import { useT } from '@/shared/i18n'

/**
 * Hook: manages explorer session list for the main chat.
 */
export function useExplorerSessions() {
  const activeProject = useProjectStore((s) => s.activeProject)
  return useSessionList(activeProject?.path)
}

interface SessionSidebarProps {
  sessions: SessionMeta[]
  currentSessionId: string | null
  /** Session whose subscribe is in flight (snapshot not back yet) → tail spinner. */
  loadingSessionId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string, e: React.MouseEvent) => void
  onLoadMore: () => void
  hasMore: boolean
  loadingMore: boolean
}

/**
 * Scrollable session list body for the full-height right session panel
 * (SessionRightPanel provides the chrome: header, collapse, New Session).
 * Item content mirrors the shared SessionListDropdown (🎯 badge, meta line,
 * hover actions). Inline rename interaction mirrors agent-sessions-sidebar.
 */
export function SessionSidebar({
  sessions,
  currentSessionId,
  loadingSessionId,
  onSelect,
  onDelete,
  onLoadMore,
  hasMore,
  loadingMore,
}: SessionSidebarProps) {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)

  // Inline title rename. `editingId` is the session whose title is being
  // edited; `editingTitle` holds the in-progress text. The ref mirror is the
  // double-commit guard: Enter also fires the input's unmount blur — one
  // commit per edit.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editingIdRef = useRef<string | null>(null)
  const editingOriginalRef = useRef('')

  const startRename = (e: React.MouseEvent, s: SessionMeta) => {
    e.stopPropagation()
    editingIdRef.current = s.id
    editingOriginalRef.current = s.title || ''
    setEditingId(s.id)
    setEditingTitle(s.title || '')
  }

  const cancelRename = () => {
    editingIdRef.current = null
    setEditingId(null)
    setEditingTitle('')
  }

  const commitRename = async (sid: string) => {
    // Already committed/cancelled (Enter then the input's unmount blur).
    if (editingIdRef.current !== sid) return
    const title = editingTitle.trim()
    // Empty or unchanged title → plain cancel. Skipping the no-op PATCH avoids
    // a pointless session:changed broadcast — blur commits fire on every focus loss.
    if (!title || title === editingOriginalRef.current || !activeProject?.path) {
      cancelRename()
      return
    }
    editingIdRef.current = null
    setEditingId(null)
    try {
      await api.sessionLogs.rename(sid, title, activeProject.path)
    } catch (err) {
      console.error('[SessionSidebar] Rename failed:', err)
    }
    // Success or failure, re-sync every list consumer with the server truth
    // (useSessionList refetches on the bus bump; the server's own
    // session:changed push covers other clients).
    bumpSessionBus()
  }

  // Infinite scroll: observe a sentinel at the list's bottom; when it enters
  // the scroll viewport, pull the next page. Dep on sessions.length re-attaches
  // the observer to the fresh sentinel position after each appended page.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) onLoadMore()
    }, { rootMargin: '48px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onLoadMore, sessions.length])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
            {t('sessions.empty')}
          </div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                'group relative mx-1.5 my-0.5 flex cursor-pointer select-none items-center rounded-xl px-2.5 py-2 transition-colors',
                currentSessionId === s.id ? 'bg-[var(--primary)]/10' : 'hover:bg-[var(--secondary)]',
              )}
            >
              <div className="min-w-0 flex-1">
                {editingId === s.id ? (
                  <input
                    autoFocus
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void commitRename(s.id) }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                    }}
                    onBlur={() => commitRename(s.id)}
                    className="w-full rounded border border-[var(--border)] bg-[var(--background)] px-1 py-0.5 text-xs text-[var(--foreground)] outline-none focus:border-blue-500"
                  />
                ) : (
                  /* WorkBuddy-style row: title on the left, relative time
                     flush right (hover actions overlay instead of taking
                     layout space, so the time really hugs the edge). */
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--foreground)]">
                      {s.goalSessionId && <span title={t('ui.goalWorker')} className="mr-1">🎯</span>}
                      {s.title}
                    </p>
                    <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                      {formatRelativeTime(s.updatedAt, t)}
                    </span>
                  </div>
                )}
              </div>
              {loadingSessionId === s.id ? (
                <Loader2 className="absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin text-[var(--muted-foreground)]" />
              ) : editingId !== s.id && (
                <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-[var(--card)] px-0.5 py-0.5 shadow-sm group-hover:flex">
                  <button
                    onClick={(e) => startRename(e, s)}
                    title={t('ui.rename')}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-blue-400"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={(e) => onDelete(s.id, e)}
                    title={t('ui.delete')}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-red-400"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        {hasMore && (
          <div ref={sentinelRef} className="flex items-center justify-center py-2 text-[10px] text-[var(--muted-foreground)]">
            {loadingMore ? (
              <><Loader2 className="h-2.5 w-2.5 animate-spin mr-1" /> {t('ui.loading')}</>
            ) : (
              <span className="opacity-50">{t('ui.scrollMore')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export { SessionHistoryLink }
