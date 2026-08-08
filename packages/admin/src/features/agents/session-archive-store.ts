'use client'

import { create } from 'zustand'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import type { ChatMessage } from '@/shared/types'

/**
 * Scroll-up archive history for the Sessions tab's detail panel.
 *
 * Same segment walk the Chat panel does (features/chat/archive-store.ts) but
 * over the SELECTED session instead of the live chat session — that store is
 * a singleton bound to the chat subscription, so repointing it here would
 * clobber the Chat panel's own history state. This one is anchored from the
 * `archiveCount` header field of the session-log GET (non-live selections)
 * or mirrored from the chat archive store's anchor (live selection — see
 * session-chat-panel), and walks the cursor down one segment per
 * scroll-to-top gesture.
 *
 * No segment cache (unlike the chat store): the walk resets on every
 * selection switch, so revisiting a session re-pulls only on an explicit
 * gesture — one GET per segment, acceptable for a browsing view.
 */

interface SessionArchiveStore {
  /** Selection the walk belongs to — null until an anchor lands. */
  sessionId: string | null
  /** Committed segment count the walk started from. */
  anchor: number
  /** Next segment to pull; 0 = nothing earlier left. */
  cursor: number
  /** Every pulled segment, oldest-first. */
  messages: ChatMessage[]
  loading: boolean
}

export const useSessionArchiveStore = create<SessionArchiveStore>(() => ({
  sessionId: null,
  anchor: 0,
  cursor: 0,
  messages: [],
  loading: false,
}))

/**
 * (Re)bind the walk. Mirrors noteArchiveAnchor's semantics: idempotent for
 * the same session unless the count grew (a compact that fires while the
 * session is on screen commits a new segment — restart the walk so the
 * just-archived turns become reachable); a different session always rebinds,
 * which is also the "selection switched → drop cursor + pulled messages"
 * reset path.
 */
export function anchorSessionArchive(sessionId: string, archiveCount: number): void {
  const state = useSessionArchiveStore.getState()
  if (state.sessionId === sessionId && archiveCount <= state.anchor) return
  useSessionArchiveStore.setState({ sessionId, anchor: archiveCount, cursor: archiveCount, messages: [], loading: false })
}

/** Pull one segment older. No-op when unbound, exhausted, or already in
 *  flight. A result that lands after the walk moved on (selection switch,
 *  re-anchor) is discarded — the sessionId+cursor pair identifies the walk. */
export async function loadOlderSessionArchive(): Promise<void> {
  const projectId = useProjectStore.getState().activeProject?.id
  const { sessionId, cursor, loading } = useSessionArchiveStore.getState()
  if (!projectId || !sessionId || cursor < 1 || loading) return

  useSessionArchiveStore.setState({ loading: true })
  try {
    const res = await api.sessionLogs.archiveSegment(sessionId, cursor, projectId)
    const state = useSessionArchiveStore.getState()
    if (state.sessionId !== sessionId || state.cursor !== cursor) return
    useSessionArchiveStore.setState({
      messages: [...(res.messages ?? []), ...state.messages],
      cursor: cursor - 1,
      loading: false,
    })
  } catch (err) {
    // Cursor stays put so the load-older row remains a retry; no bubble — a
    // failed history pull must not read as a session error.
    console.debug(`[SessionArchiveStore] segment ${cursor} failed: ${err instanceof Error ? err.message : String(err)}`)
    const state = useSessionArchiveStore.getState()
    if (state.sessionId === sessionId && state.cursor === cursor) {
      useSessionArchiveStore.setState({ loading: false })
    }
  }
}
