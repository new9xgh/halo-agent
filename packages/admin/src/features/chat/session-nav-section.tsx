'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { SessionSidebar, useExplorerSessions } from './session-list'
import { useSessionController } from './session-controller'
import { useChatStore } from '@/features/chat/chat-store'
import { confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'

/**
 * Session ("任务/对话") section of the left navigation column, WorkBuddy-style:
 * a section header with the session count, then the scrollable SessionSidebar
 * list. (No "new session" button here — the nav's 新建任务 item covers that.)
 * All session operations go through the shared session controller so this
 * stays in sync with the chat view.
 */
export function SessionNavSection({ onOpenSession }: { onOpenSession?: () => void }) {
  const t = useT()
  const loadSession = useSessionController((s) => s.loadSession)
  const loadingSessionId = useSessionController((s) => s.loadingSessionId)
  const deleteSession = useSessionController((s) => s.deleteSession)
  const sessionId = useChatStore((s) => s.sessionId)
  const { sessions, remove: removeSession, loadMore, hasMore, loadingMore } = useExplorerSessions()

  const handleSelect = (sid: string) => {
    loadSession(sid)
    onOpenSession?.()
  }

  const handleDelete = async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!(await confirmAction(t('sessions.deleteConfirm')))) return
    deleteSession(sid)
    await removeSession(sid)
  }

  const [listOpen, setListOpen] = useState(true)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* WorkBuddy-style collapsible section header: 任务 (N) ⌄ */}
      <button
        onClick={() => setListOpen(!listOpen)}
        className="flex w-full shrink-0 items-center gap-1 px-3 pt-2 pb-1 text-xs font-normal text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        {t('sessions.tasks')} ({sessions.length})
        {listOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {listOpen && (
        <SessionSidebar
          sessions={sessions}
          currentSessionId={sessionId}
          loadingSessionId={loadingSessionId}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onLoadMore={loadMore}
          hasMore={hasMore}
          loadingMore={loadingMore}
        />
      )}
    </div>
  )
}
