'use client'

import { useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback } from 'react'
import { useChatStore } from '@/features/chat/chat-store'
import { useSessionViewStore } from './agent-sessions-sidebar'
import { useSessionArchiveStore, anchorSessionArchive, loadOlderSessionArchive } from './session-archive-store'
import { useArchiveStore } from '@/features/chat/archive-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { api } from '@/shared/api-client'
import { wsClient } from '@/shared/ws-client'
import { onWsReconnect } from '@/shared/ws-reconnect'
import type { ChatMessage } from '@/shared/types'
import { MessageList } from '@/shared/components/message-list'
import { timeAgo } from '@/shared/components/session-list-dropdown'
import { useT } from '@/shared/i18n'
import { Bot, Bug, FileText, ListFilter, Loader2, X, Copy, Check } from 'lucide-react'
import { cn } from '@/shared/utils'
import { isMainConversationMessage, isDebugMessage, inferMessageType } from '@/shared/types'

/**
 * Reuse previous message object identities for entries whose content is
 * unchanged, so MessageList's memoized exchange rows skip re-render. The
 * refetch below fires on every write to the selected session's file —
 * including rewrites that change no messages (e.g. a title PATCH) — and a
 * wholesale array replace hands every row a brand-new object, re-running
 * ReactMarkdown across the whole conversation: the detail-panel flash.
 *
 * Session logs are append-only: settled rows never change bytes, the only
 * in-place mutation is the LAST row absorbing updates (tool results landing,
 * streaming text growing) — plus rare wholesale rewrites (compact, exchange
 * soft-delete). So deep-comparing every row on every write (previously two
 * JSON.stringify passes over a multi-MB transcript per file:changed event)
 * buys nothing: reuse the prefix by reference outright, deep-compare only
 * the boundary row where appends land, and fall back to the positional
 * deep-compare walk only when the tail probe says the prefix shifted.
 * When nothing changed at all, return `prev` so the store set is a no-op.
 */
function reconcileMessages(prev: ChatMessage[] | null, next: ChatMessage[]): ChatMessage[] {
  if (!prev || prev.length === 0) return next

  // Append fast path. Settled rows never change bytes EXCEPT the `deleted`
  // flag, which exchange soft-delete flips on mid-array rows in place
  // (server deleteExchange keeps array length). So the prefix check is a
  // cheap scalar probe — id + deleted, no serialization — and only the last
  // 2 overlap rows (where streaming text / tool results / usage still land)
  // get the deep compare. Anything off-shape falls to the full walk.
  const overlap = Math.min(prev.length, next.length)
  const deepFrom = Math.max(0, prev.length - 2)
  let appendShape = next.length >= prev.length
  for (let i = 0; appendShape && i < deepFrom; i++) {
    if (prev[i].id !== next[i].id || prev[i].deleted !== next[i].deleted) appendShape = false
  }
  if (appendShape) {
    let reusedAll = prev.length === next.length
    const out = next.slice()
    for (let i = 0; i < deepFrom; i++) out[i] = prev[i]
    for (let i = deepFrom; i < overlap; i++) {
      if (JSON.stringify(prev[i]) === JSON.stringify(next[i])) {
        out[i] = prev[i]
      } else {
        reusedAll = false
      }
    }
    return reusedAll ? prev : out
  }

  // Non-append rewrite (compact, soft-delete, repair): positional
  // deep-compare, reusing whatever still matches so unchanged rows keep
  // identity for the memo comparator.
  let reusedAll = prev.length === next.length
  const out = next.map((m, i) => {
    const old = prev[i]
    if (old && JSON.stringify(old) === JSON.stringify(m)) return old
    reusedAll = false
    return m
  })
  return reusedAll ? prev : out
}

export function SessionChatPanel() {
  const t = useT()
  const currentMessages = useChatStore((s) => s.messages)
  const currentSessionId = useChatStore((s) => s.sessionId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const selectedSessionId = useSessionViewStore((s) => s.selectedSessionId)
  const selectedSession = useSessionViewStore((s) => s.selectedSession)
  const loadedMessages = useSessionViewStore((s) => s.loadedMessages)
  const loading = useSessionViewStore((s) => s.loading)
  const activeProject = useProjectStore((s) => s.activeProject)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [debugMode, setDebugMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_session_debug') === '1'
  })
  const [showPrompt, setShowPrompt] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_session_prompt') === '1'
  })

  const copySessionId = () => {
    if (!selectedSessionId) return
    navigator.clipboard.writeText(selectedSessionId).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }

  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('halo_session_debug', debugMode ? '1' : '0')
  }, [debugMode])
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('halo_session_prompt', showPrompt ? '1' : '0')
  }, [showPrompt])

  // For sub / historical sessions, re-fetch when the underlying session.json
  // changes on disk (agent appends a message). Current live session is driven
  // by WS stream and skipped here to avoid double-updates.
  const setLoadedMessages = useSessionViewStore((s) => s.setLoadedMessages)
  useEffect(() => {
    if (!selectedSessionId || !activeProject?.path) return
    if (selectedSessionId === currentSessionId) return // live session — WS handles updates
    const refetch = () => {
      api.sessionLogs.get(selectedSessionId, activeProject.path)
        .then((res) => {
          // A compact that fires while the session is on screen rewrites the
          // active file with a higher archiveCount — re-anchor so the
          // just-archived turns become reachable (no-op unless it grew).
          anchorSessionArchive(selectedSessionId, typeof res.archiveCount === 'number' ? res.archiveCount : 0)
          const fresh = (res.messages as unknown as ChatMessage[]) ?? []
          const prev = useSessionViewStore.getState().loadedMessages
          const next = reconcileMessages(prev, fresh)
          if (next !== prev) setLoadedMessages(next)
        })
        .catch(() => {})
    }
    // Session files are named by the last segment of the id (e.g. full id
    // "root>sid_abc" → file "sid_abc.json"), so match on basename not full id.
    const fileBase = selectedSessionId.split('>').pop() ?? selectedSessionId
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      // Session files are written atomically (tmp + rename-over-existing), which
      // the native watcher reports as `create` → action 'add', not 'change'.
      if (msg.action !== 'change' && msg.action !== 'add') return
      if (!msg.path.startsWith('.halo/sessions/')) return
      if (!msg.path.endsWith(`/${fileBase}.json`)) return
      refetch()
    })
    // Reconnect reconciliation — a session write while the socket was down
    // emits no delta, leaving the transcript stale. See shared/ws-reconnect.
    const unsubReconnect = onWsReconnect(wsClient, refetch)
    return () => { unsub(); unsubReconnect() }
  }, [selectedSessionId, currentSessionId, activeProject?.path, setLoadedMessages])

  // Determine which messages to show
  const messages = useMemo(() => {
    if (!selectedSessionId) return []

    // If viewing the current live session, use real-time in-memory messages.
    // currentMessages holds the entire root-tree stream (root + sub-agents),
    // so we must drop any message tagged with a taskId — those belong to a
    // sub-session and have their own row in the tree. Without this, debug
    // mode on the live root would show every descendant's stream/tool_call
    // events inline, then "snap back" to the correct view after a refresh
    // (the on-disk root file only carries its own messages).
    if (selectedSessionId === currentSessionId) {
      const ownMessages = currentMessages.filter((m) => !m.taskId)
      if (debugMode) return ownMessages
      return ownMessages.filter(isMainConversationMessage)
    }

    // Otherwise use loaded messages from API — filter debug messages only (not by agentName/taskId)
    const loaded = loadedMessages ?? []
    if (debugMode) return loaded
    return loaded.filter((m) => !isDebugMessage(m))
  }, [selectedSessionId, currentSessionId, currentMessages, loadedMessages, debugMode])

  // Extract system prompt from messages
  const systemPrompt = useMemo(() => {
    const allMsgs = selectedSessionId === currentSessionId ? currentMessages : (loadedMessages ?? [])
    for (const m of allMsgs) {
      if (inferMessageType(m) === 'context' && m.systemPrompt) return m.systemPrompt
    }
    return null
  }, [selectedSessionId, currentSessionId, currentMessages, loadedMessages])

  // ── Archived history (scroll-to-top segment walk) ──────────────────────
  // Anchored by the sidebar's session-log GET (non-live selections) or
  // mirrored from the chat archive store below (live selection — its anchor
  // arrived on the subscribe snapshot; the segment files on disk don't care
  // whether the session is live).
  const archSessionId = useSessionArchiveStore((s) => s.sessionId)
  const archAnchor = useSessionArchiveStore((s) => s.anchor)
  const archCursor = useSessionArchiveStore((s) => s.cursor)
  const archMessages = useSessionArchiveStore((s) => s.messages)
  const archLoading = useSessionArchiveStore((s) => s.loading)
  // Bound = the walk belongs to the current selection. A stale binding (from
  // the previous selection, until its anchor call lands) must not render.
  const archBound = archSessionId !== null && archSessionId === selectedSessionId

  const chatArchSessionId = useArchiveStore((s) => s.sessionId)
  const chatArchAnchor = useArchiveStore((s) => s.anchor)
  useEffect(() => {
    if (!selectedSessionId || selectedSessionId !== currentSessionId) return
    if (chatArchSessionId !== selectedSessionId) return
    anchorSessionArchive(selectedSessionId, chatArchAnchor)
  }, [selectedSessionId, currentSessionId, chatArchSessionId, chatArchAnchor])

  // Same debug filter the loadedMessages path uses above — archived segments
  // carry the full raw log (tool calls, usage rows), so non-debug view hides
  // them the same way.
  const archivedVisible = useMemo(() => {
    if (!archBound) return []
    if (debugMode) return archMessages
    return archMessages.filter((m) => !isDebugMessage(m))
  }, [archBound, archMessages, debugMode])

  const wasAtBottom = useRef(true)
  // Distance-from-bottom captured just before a segment prepend. Prepending
  // grows the content ABOVE the viewport while the browser keeps `scrollTop`,
  // which would yank the reader; the layout effect below restores the
  // distance so the same messages stay under the cursor.
  const archScrollAnchor = useRef<number | null>(null)
  // One segment per scroll-to-top GESTURE — re-armed only after the user
  // scrolls back down (>200), so one flick can't cascade through the archive.
  const topTriggerArmed = useRef(true)

  const handleLoadOlder = useCallback(() => {
    // Guard before capturing the anchor: an exhausted / in-flight walk must
    // not leave a stale anchor behind for a later prepend to mis-restore.
    const st = useSessionArchiveStore.getState()
    if (st.sessionId !== selectedSessionId || st.cursor < 1 || st.loading) return
    const el = scrollRef.current
    archScrollAnchor.current = el ? el.scrollHeight - el.scrollTop : null
    void loadOlderSessionArchive()
  }, [selectedSessionId])

  // Selection switch: the store rebinds via anchorSessionArchive (sidebar /
  // live mirror); the per-panel gesture state resets here.
  useEffect(() => {
    topTriggerArmed.current = true
    archScrollAnchor.current = null
  }, [selectedSessionId])

  // Track scroll position
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      if (el.scrollTop > 200) topTriggerArmed.current = true
      else if (el.scrollTop < 80 && topTriggerArmed.current) {
        topTriggerArmed.current = false
        handleLoadOlder()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [handleLoadOlder])

  // Restore the reading position after a prepend — layout effect so the
  // correction lands before paint. Keyed on the store's message array: it
  // changes exactly when a segment lands.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = archScrollAnchor.current
    if (!el || anchor === null) return
    el.scrollTop = el.scrollHeight - anchor
    archScrollAnchor.current = null
  }, [archMessages])

  // Auto-scroll only when already at bottom
  useEffect(() => {
    if (wasAtBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  return (
    <div className="flex h-full flex-col bg-[var(--background)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 min-w-0">
        {selectedSessionId ? (
          <>
            <ListFilter className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
            {selectedSession?.agentName && (
              <span className="shrink-0 rounded bg-purple-900/50 px-1.5 py-0.5 text-[10px] text-purple-400">
                {selectedSession.agentName}
              </span>
            )}
            <span
              className="truncate text-xs font-medium text-[var(--foreground)]"
              title={selectedSession?.title || 'Untitled'}
            >
              {selectedSession?.title || 'Untitled'}
            </span>
            <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">({messages.length})</span>
            {selectedSessionId === currentSessionId && (
              <span className="shrink-0 rounded bg-blue-900/50 px-1.5 py-0.5 text-[8px] text-blue-400">live</span>
            )}
            {selectedSession?.parentSessionId && (
              <span className="shrink-0 rounded bg-[var(--secondary)] px-1 py-0.5 text-[8px] text-[var(--muted-foreground)]" title="Sub-session">sub</span>
            )}
            {selectedSession?.stoppedAt && (
              <span className="shrink-0 rounded bg-[var(--secondary)] px-1 py-0.5 text-[8px] text-[var(--muted-foreground)]">stopped</span>
            )}
            {selectedSession?.archivedAt && (
              <span
                className="shrink-0 rounded bg-amber-900/50 px-1 py-0.5 text-[8px] text-amber-400"
                title={`Archived: ${new Date(selectedSession.archivedAt).toLocaleString()}`}
              >
                archived
              </span>
            )}
            {selectedSession?.createdAt && (
              <span
                className="shrink-0 text-[10px] text-[var(--muted-foreground)]"
                title={`Created: ${new Date(selectedSession.createdAt).toLocaleString()}`}
              >
                {timeAgo(selectedSession.createdAt)}
              </span>
            )}
            <button
              onClick={copySessionId}
              title={`Session ID: ${selectedSessionId}`}
              className="shrink-0 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors"
            >
              {copied ? <Check className="h-2.5 w-2.5 text-green-400" /> : <Copy className="h-2.5 w-2.5" />}
              {selectedSessionId.slice(0, 8)}
            </button>
          </>
        ) : (
          <>
            <Bot className="h-4 w-4 text-[var(--muted-foreground)]" />
            <span className="text-sm font-medium text-[var(--foreground)]">Session Viewer</span>
          </>
        )}
        {selectedSessionId && (
          <div className="ml-auto flex items-center gap-1">
            {systemPrompt && (
              <button
                onClick={() => setShowPrompt(!showPrompt)}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
                  showPrompt
                    ? 'bg-purple-900/50 text-purple-400'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
                )}
                title="View system prompt"
              >
                <FileText className="h-3 w-3" />
                Prompt
              </button>
            )}
            <button
              onClick={() => setDebugMode(!debugMode)}
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] transition-colors',
                debugMode
                  ? 'bg-amber-900/50 text-amber-400'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
              )}
              title="Debug mode: show all messages including sub-agent tool calls"
            >
              <Bug className="h-3 w-3" />
              Debug
            </button>
          </div>
        )}
        {isStreaming && selectedSessionId === currentSessionId && (
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-[9px] text-blue-400 animate-pulse">streaming</span>
        )}
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-y-auto">
        {showPrompt && systemPrompt && (
          <div className="sticky top-2 right-2 z-10 float-right ml-2 mb-2 mr-2 w-[min(520px,80%)] rounded-md border border-purple-900/60 bg-[var(--background)] shadow-lg">
            <div className="flex items-center justify-between border-b border-purple-900/50 bg-purple-950/40 px-3 py-1.5 rounded-t-md">
              <span className="text-[10px] font-semibold text-purple-400">System Prompt</span>
              <button onClick={() => setShowPrompt(false)} title="Close" className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]">
                <X className="h-3 w-3" />
              </button>
            </div>
            <pre className="px-3 py-2 text-[11px] text-[var(--foreground)] whitespace-pre-wrap break-words leading-relaxed max-h-[60vh] overflow-y-auto">{systemPrompt}</pre>
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Loading session...
          </div>
        ) : !selectedSessionId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Bot className="h-8 w-8 text-[var(--muted-foreground)]" />
            <p className="text-sm text-[var(--muted-foreground)]">
              Select a session from the sidebar to view messages
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <Bot className="h-8 w-8 text-[var(--muted-foreground)]" />
            <p className="text-sm text-[var(--muted-foreground)]">No messages in this session</p>
          </div>
        ) : (
          <>
            {/* Archived history above the transcript. Simpler than the Chat
                panel's collapsed ArchiveHistory block (that component is
                coupled to the chat-session singleton store): pulled segments
                render expanded, with one boundary row marking where the
                archive ends and the active log begins. readOnly — these turns
                left the active log, so exchange:delete can't target them. */}
            {archBound && archAnchor > 0 && (
              <div className="border-b border-[var(--border)]/50">
                {archCursor > 0 ? (
                  <button
                    onClick={handleLoadOlder}
                    disabled={archLoading}
                    className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[10px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:hover:bg-transparent"
                  >
                    {archLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                    {archLoading ? t('chat.archive.loading') : t('chat.archive.loadOlder')}
                  </button>
                ) : (
                  <div className="px-3 py-2 text-center text-[10px] text-[var(--muted-foreground)]">
                    {t('chat.archive.noEarlier')}
                  </div>
                )}
                {archivedVisible.length > 0 && (
                  <>
                    <MessageList messages={archivedVisible} debugMode={debugMode} readOnly />
                    <div className="border-t border-[var(--border)]/50 px-3 py-2 text-center text-[10px] text-[var(--muted-foreground)]">
                      {t('chat.archive.header', { segments: archAnchor - archCursor, messages: archivedVisible.length })}
                    </div>
                  </>
                )}
              </div>
            )}
            <MessageList messages={messages} debugMode={debugMode} />
          </>
        )}
      </div>
    </div>
  )
}
