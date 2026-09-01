'use client'

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
    if (!(await confirmAction('Delete this session? Its history cannot be recovered.'))) return
    deleteSession(sid)
    await removeSession(sid)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center px-3 pt-2 pb-1">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">
          {t('sessions.tasks')} ({sessions.length})
        </span>
      </div>
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
    </div>
  )
}
