'use client'

import { create } from 'zustand'
import { wsClient } from '@/shared/ws-client'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { getStoredSessionId, removeStoredSessionId } from './use-chat'

/** Session sidebar open/closed — a global preference (unlike the per-project
 *  `halo_session_${projectId}` current-session keys). */
const SIDEBAR_OPEN_KEY = 'halo_session_sidebar_open'

/**
 * Session loading controller, lifted out of ChatPanel so the full-height
 * right session panel (rendered by workspace-layout, outside the bottom
 * panel) shares one load pipeline with the chat view: both spinners, the
 * Retry button and GoalBanner's jump all drive/observe this store.
 *
 * Load completion is keyed off the server's `state:snapshot` reply to our
 * `subscribe` (it answers even empty sessions with recentMessages: []), not
 * "messages arrived" — and only a snapshot for the sid being loaded clears
 * the state, so a late snapshot from a previous switch can't wipe a newer
 * load. Past 30s the UI surfaces a slow-network hint + Retry, but keeps
 * waiting — the snapshot still clears everything.
 */
interface SessionControllerState {
  /** Session whose subscribe is in flight (snapshot not back yet). */
  loadingSessionId: string | null
  slowLoading: boolean
  sidebarOpen: boolean
  loadSession: (sid: string) => void
  clearLoading: () => void
  setSidebar: (open: boolean) => void
  /** Start a new session — resets agent but keeps old session in DB for
   *  history. Same logic as useChat's clearSession, duplicated here because
   *  useChat registers WS subscriptions and can't be instantiated twice. */
  newSession: () => void
  /** Delete a session from DB permanently (clears the UI if it's current). */
  deleteSession: (sid: string) => void
}

let slowTimer: ReturnType<typeof setTimeout> | null = null

function armSlowTimer(set: (p: Partial<SessionControllerState>) => void, get: () => SessionControllerState) {
  if (slowTimer) clearTimeout(slowTimer)
  slowTimer = setTimeout(() => {
    if (get().loadingSessionId) set({ slowLoading: true })
  }, 30_000)
}

export const useSessionController = create<SessionControllerState>((set, get) => ({
  loadingSessionId: null,
  slowLoading: false,
  sidebarOpen: typeof window === 'undefined'
    ? true
    : (() => { try { return localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false' } catch { return true } })(),

  loadSession: (sid) => {
    const project = useProjectStore.getState().activeProject
    if (!project) return
    set({ loadingSessionId: sid, slowLoading: false })
    armSlowTimer(set, get)
    useChatStore.getState().setSessionId(sid)
    useChatStore.getState().setMessages([])
    wsClient.send({ type: 'subscribe', sessionId: sid, projectId: project.id })
    try { localStorage.setItem(`halo_session_${project.id}`, sid) } catch { /* ignore */ }
  },

  clearLoading: () => {
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null }
    set({ loadingSessionId: null, slowLoading: false })
  },

  setSidebar: (open) => {
    set({ sidebarOpen: open })
    try { localStorage.setItem(SIDEBAR_OPEN_KEY, String(open)) } catch { /* ignore */ }
  },

  newSession: () => {
    const project = useProjectStore.getState().activeProject
    if (!project) return
    // Drop any in-flight load — its snapshot (matched by sid) can't collide
    // with the fresh session, but the spinner must not linger over it.
    get().clearLoading()
    const currentSessionId = useChatStore.getState().sessionId ?? getStoredSessionId(project.id)
    // Tell server to reset session (session stays in DB). Session lists
    // refresh on the server's `session:cleared` reply (bus bump in
    // chat-handlers) — it lands after the cleared session is persisted.
    if (currentSessionId) {
      wsClient.send({ type: 'session:clear', sessionId: currentSessionId })
    }
    removeStoredSessionId(project.id)
    useChatStore.getState().clear()
  },

  deleteSession: (sid) => {
    const project = useProjectStore.getState().activeProject
    if (!project) return
    wsClient.send({ type: 'session:delete', sessionId: sid, projectId: project.path })
    // If deleting the current session, also clear UI
    const currentSessionId = useChatStore.getState().sessionId ?? getStoredSessionId(project.id)
    if (sid === currentSessionId) {
      removeStoredSessionId(project.id)
      useChatStore.getState().clear()
    }
  },
}))

// Module-level snapshot listener — the load-completion signal. Guarded for
// build-time prerender (client modules are still evaluated in Node during
// static export); wsClient only exists meaningfully in the browser.
if (typeof window !== 'undefined') {
  wsClient.on('state:snapshot', (data) => {
    const snap = (data as { snapshot?: { sessionId?: string } }).snapshot
    const { loadingSessionId, clearLoading } = useSessionController.getState()
    if (loadingSessionId && snap?.sessionId === loadingSessionId) clearLoading()
  })
}
