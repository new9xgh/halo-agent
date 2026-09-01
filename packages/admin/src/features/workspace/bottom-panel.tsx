'use client'

import { ChatPanel } from '@/features/chat/chat-panel'
import { useExplorerSessions } from '@/features/chat/session-list'
import { useChatStore } from '@/features/chat/chat-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { cn } from '@/shared/utils'
import { Maximize2, Minimize2, PictureInPicture2, X } from 'lucide-react'
import { useT } from '@/shared/i18n'

interface BottomPanelProps {
  cwd?: string
  /** When set, clicking the top-right icon calls this (used for Dock back when floating) */
  floating?: boolean
  /** Ref for the drag handle area (float mode only). Mouse events on the tab bar trigger drag. */
  dragHandleRef?: React.RefObject<HTMLDivElement | null>
}

/** Center conversation panel — chat only (the terminal tab was removed; the
 *  panel keeps its slim header so the float/maximize controls and the float
 *  drag handle still have a home). The header shows the CURRENT SESSION'S
 *  TITLE (WorkBuddy-style), falling back to "New Session" before the first
 *  turn persists it. */
export function BottomPanel({ floating = false, dragHandleRef }: BottomPanelProps = {}) {
  const t = useT()
  const setBottomFloating = useEditorStore((s) => s.setBottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  const setBottomMaximized = useEditorStore((s) => s.setBottomMaximized)
  const sessionId = useChatStore((s) => s.sessionId)
  const { sessions } = useExplorerSessions()
  const sessionTitle = sessions.find((s) => s.id === sessionId)?.title ?? t('sessions.new')

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      {/* Slim header: session title + panel controls (drag handle when floating) */}
      <div
        ref={dragHandleRef}
        className={cn(
          'flex h-[35px] shrink-0 items-center gap-0 border-b border-[var(--border)] bg-[var(--card)] px-3',
          floating && 'cursor-move select-none',
        )}
      >
        <span className="truncate text-xs font-medium tracking-wide text-[var(--foreground)]">
          {sessionTitle}
        </span>
        <div className="flex-1" />
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setBottomMaximized(!bottomMaximized)}
          title={bottomMaximized ? 'Restore panel' : 'Maximize panel'}
          className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {bottomMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setBottomFloating(!floating)}
          title={floating ? 'Dock back' : 'Float panel'}
          className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          {floating ? <X className="h-3.5 w-3.5" /> : <PictureInPicture2 className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        <ChatPanel />
      </div>
    </div>
  )
}
