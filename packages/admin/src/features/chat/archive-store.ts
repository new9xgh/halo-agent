'use client'

import { create } from 'zustand'
import { api } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import type { ChatMessage } from '@/shared/types'

/**
 * Scroll-up history for archived UI-log segments.
 *
 * Opening a session is unchanged — the server still hands back the whole
 * active file in `state:snapshot`. That snapshot also carries `archiveCount`,
 * the number of committed `<seg>.arch.<N>.json.gz` segments, which becomes
 * this store's ANCHOR. The cursor then walks down from it: each scroll-to-top
 * pulls segment `cursor` whole, prepends it, and decrements. 0 means the whole
 * archive is loaded (or there was none).
 *
 * The anchor is pinned at open time on purpose: a segment written while the
 * session is being viewed (a compact mid-conversation) does not move it, so
 * the numbering the client walks down can never shift under it.
 */

/** Pulled segments, keyed `${sessionId}\u0000${n}`. A committed segment file is
 *  immutable, so re-opening a session never re-requests one. Bounded FIFO: a
 *  segment is a whole batch of exchanges (tens to hundreds of KB), so an
 *  unbounded map would grow with every session the user browses. */
const segmentCache = new Map<string, ChatMessage[]>()
const SEGMENT_CACHE_LIMIT = 20

function cacheSegment(key: string, messages: ChatMessage[]): void {
  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) {
    const oldest = segmentCache.keys().next().value
    if (oldest !== undefined) segmentCache.delete(oldest)
  }
  segmentCache.set(key, messages)
}

interface ArchiveStore {
  /** Session the loaded segments belong to — null before any snapshot. */
  sessionId: string | null
  /** Committed segment count at open time (the walk's starting point). */
  anchor: number
  /** Next segment to pull; 0 = nothing earlier left. */
  cursor: number
  /** Every pulled segment, oldest-first. */
  messages: ChatMessage[]
  loading: boolean
}

export const useArchiveStore = create<ArchiveStore>(() => ({
  sessionId: null,
  anchor: 0,
  cursor: 0,
  messages: [],
  loading: false,
}))

/**
 * Bind the anchor from a `state:snapshot`. Idempotent per session: a
 * re-subscribe (stale-link reconnect) or a per-turn snapshot must not drop
 * segments the user already pulled, and a segment archived after open must not
 * move the anchor.
 */
export function noteArchiveAnchor(sessionId: string, archiveCount: number): void {
  if (useArchiveStore.getState().sessionId === sessionId) return
  useArchiveStore.setState({ sessionId, anchor: archiveCount, cursor: archiveCount, messages: [], loading: false })
}

/** Prepend a segment, unless the store moved on while the fetch was in flight
 *  (session switch, or this segment already landed from the cache path). */
function applySegment(sessionId: string, n: number, messages: ChatMessage[]): void {
  const state = useArchiveStore.getState()
  if (state.sessionId !== sessionId || state.cursor !== n) return
  useArchiveStore.setState({ messages: [...messages, ...state.messages], cursor: n - 1, loading: false })
}

/** Pull one segment older. No-op when the archive is exhausted or a pull is
 *  already in flight — both the scroll trigger and the explicit button call
 *  this, so the guards live here rather than at each call site. */
export async function loadOlderArchive(): Promise<void> {
  const projectId = useProjectStore.getState().activeProject?.id
  const { sessionId, cursor, loading } = useArchiveStore.getState()
  if (!projectId || !sessionId || cursor < 1 || loading) return

  const key = `${sessionId}\u0000${cursor}`
  const cached = segmentCache.get(key)
  if (cached) {
    applySegment(sessionId, cursor, cached)
    return
  }

  useArchiveStore.setState({ loading: true })
  try {
    const res = await api.sessionLogs.archiveSegment(sessionId, cursor, projectId)
    const messages = res.messages ?? []
    cacheSegment(key, messages)
    applySegment(sessionId, cursor, messages)
  } catch (err) {
    // Leave the cursor where it is — the load-older row stays, so the user can
    // retry. No bubble: a failed history pull must not look like a chat error.
    console.debug(`[ArchiveStore] segment ${cursor} failed: ${err instanceof Error ? err.message : String(err)}`)
    useArchiveStore.setState({ loading: false })
  }
}
