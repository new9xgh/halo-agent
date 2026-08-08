'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageList } from '@/shared/components/message-list'
import { useArchiveStore } from './archive-store'
import { useChatStore } from './chat-store'
import { isMainConversationMessage } from '@/shared/types'
import { useT } from '@/shared/i18n'
import { ChevronRight, ChevronUp, Loader2 } from 'lucide-react'

/**
 * Archived history above the live conversation: a "load earlier" row that walks
 * the segment cursor down (see archive-store), plus one collapsed block holding
 * every segment pulled so far. Collapsed by default — the user scrolled up to
 * reach for older context, not to have hundreds of exchanges re-flow the view.
 *
 * Read-only: `readOnly` strips the per-exchange Delete button, because the
 * server refuses `exchange:delete` for any session with archived history (the
 * ordinal↔raw-message mapping can't be reconstructed once turns left the file).
 */
export function ArchiveHistory({
  onLoadOlder,
  scrollRef,
}: {
  onLoadOlder: () => void
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const chatSessionId = useChatStore((s) => s.sessionId)
  const archiveSessionId = useArchiveStore((s) => s.sessionId)
  const anchor = useArchiveStore((s) => s.anchor)
  const cursor = useArchiveStore((s) => s.cursor)
  const messages = useArchiveStore((s) => s.messages)
  const loading = useArchiveStore((s) => s.loading)
  const [open, setOpen] = useState(false)

  // Expand upward: the block sits ABOVE the live conversation, so on toggle we
  // pin the distance-from-bottom instead of letting the browser keep
  // `scrollTop` (which would land the reader on the OLDEST archived message).
  // Restoring the from-bottom distance keeps the content below the block in
  // place — expanded history grows upward, viewport stays at its newest end.
  const toggleScrollAnchor = useRef<number | null>(null)
  const handleToggle = () => {
    const el = scrollRef.current
    toggleScrollAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    setOpen(!open)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = toggleScrollAnchor.current
    if (!el || a === null) return
    el.scrollTop = el.scrollHeight - a
    toggleScrollAnchor.current = null
  }, [open, scrollRef])

  // A session switch clears the chat store before the new snapshot rebinds the
  // anchor — until then the archive store still holds the previous session's
  // segments, which must not render under the new conversation.
  const bound = archiveSessionId !== null && archiveSessionId === chatSessionId

  const mainMessages = useMemo(() => messages.filter(isMainConversationMessage), [messages])

  if (!bound || anchor === 0) return null

  return (
    <div className="border-b border-[var(--border)]/50">
      {cursor > 0 ? (
        <button
          onClick={onLoadOlder}
          disabled={loading}
          className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:hover:bg-transparent"
        >
          {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          {loading ? t('chat.archive.loading') : t('chat.archive.loadOlder')}
        </button>
      ) : (
        <div className="px-3 py-2 text-center text-[10px] text-[var(--muted-foreground)]">
          {t('chat.archive.noEarlier')}
        </div>
      )}

      {mainMessages.length > 0 && (
        <>
          {/* Bar BELOW the content: expansion grows upward and the viewport is
              pinned to the newest end, so the toggle must live where the
              reader lands — under the cursor, not a full scroll away. */}
          {open && <MessageList messages={mainMessages} readOnly />}
          <button
            onClick={handleToggle}
            className="flex w-full items-center gap-2 border-t border-[var(--border)]/50 px-3 py-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            {/* Expanded content sits ABOVE the bar, so the open-state chevron
                points up at it (not down, which reads as "content below"). */}
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>
              {t('chat.archive.header', { segments: anchor - cursor, messages: mainMessages.length })}
            </span>
          </button>
        </>
      )}
    </div>
  )
}
