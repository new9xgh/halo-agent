'use client'

import { useMemo, useState } from 'react'
import { MessageList } from '@/shared/components/message-list'
import { useArchiveStore } from './archive-store'
import { useChatStore } from './chat-store'
import { isMainConversationMessage } from '@/shared/types'
import { useT } from '@/shared/i18n'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'

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
export function ArchiveHistory({ onLoadOlder }: { onLoadOlder: () => void }) {
  const t = useT()
  const chatSessionId = useChatStore((s) => s.sessionId)
  const archiveSessionId = useArchiveStore((s) => s.sessionId)
  const anchor = useArchiveStore((s) => s.anchor)
  const cursor = useArchiveStore((s) => s.cursor)
  const messages = useArchiveStore((s) => s.messages)
  const loading = useArchiveStore((s) => s.loading)
  const [open, setOpen] = useState(false)

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
          <button
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-2 border-t border-[var(--border)]/50 px-3 py-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span>
              {t('chat.archive.header', { segments: anchor - cursor, messages: mainMessages.length })}
            </span>
          </button>
          {open && <MessageList messages={mainMessages} readOnly />}
        </>
      )}
    </div>
  )
}
