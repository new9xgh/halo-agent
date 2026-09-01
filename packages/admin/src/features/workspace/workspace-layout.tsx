'use client'

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels'
import { BottomPanel } from '@/features/workspace/bottom-panel'
import { FloatingBottomPanel } from '@/features/workspace/floating-bottom-panel'
import { CanvasOverview } from '@/features/workspace/canvas-overview'
import { FolderPicker } from '@/features/explorer/folder-picker'
import { AgentManagementMain } from '@/features/agents/agent-management-main'
import { SkillsSidebar } from '@/features/skills/skills-sidebar'
import { SkillsMain } from '@/features/skills/skills-main'
import { SessionNavSection } from '@/features/chat/session-nav-section'
import { useSessionController } from '@/features/chat/session-controller'
import { useProjectStore } from '@/shared/stores/project-store'
import { useChatStore } from '@/features/chat/chat-store'
import { useEditorStore } from '@/shared/stores/editor-store'
import { loadFileTree } from '@/features/explorer/use-file-tree'
import { addRecentWorkspace } from '@/features/explorer/use-recent-workspaces'
import { useGitDecorationsSync, useIsRepo } from '@/features/explorer/git-decorations'
import { api } from '@/shared/api-client'
import { cn, confirmAction } from '@/shared/utils'
import { SettingsMain } from '@/features/settings/settings-main'
import { ChannelsSidebar } from '@/features/channels/channels-sidebar'
import { ChannelsMain } from '@/features/channels/channels-main'
import { EvolutionMain } from '@/features/evolution/evolution-main'
import { EvolutionSidebar } from '@/features/evolution/evolution-sidebar'
import { CronMain } from '@/features/cron/cron-main'
import { CronSidebar } from '@/features/cron/cron-sidebar'
import { SourceControlSidebar } from '@/features/source-control/source-control-sidebar'
import { SourceControlMain } from '@/features/source-control/source-control-main'
import { FolderTree, Bot, Settings2, Zap, MessageCircle, Sparkles, Clock, GitBranch, Wifi, WifiOff, Pin, PinOff, Bell, BellOff, PanelLeftClose, PanelLeftOpen, PanelRightOpen, PanelRightClose, Plus, Menu, Check, Globe, RefreshCw, ExternalLink, ArrowLeftRight } from 'lucide-react'
import { useT } from '@/shared/i18n'
import { envBadgeTitlePrefix } from '@/shared/env-badge'
import type { LinkState } from '@/shared/use-websocket'

type SidebarTab = 'explorer' | 'source-control' | 'skills' | 'management' | 'channels' | 'evolution' | 'cron' | 'settings'

const TABS_WITH_SIDEBAR: SidebarTab[] = ['explorer', 'source-control', 'skills', 'channels', 'evolution', 'cron']

// Short two-note "ding-dong" chime synthesized on the fly, so there's no audio
// file to bundle/serve. Reuses one lazily-created AudioContext (browsers cap the
// number of live contexts). No-op if WebAudio is unavailable or blocked.
let chimeCtx: AudioContext | null = null
function playChime() {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    if (!chimeCtx) chimeCtx = new Ctor()
    const ctx = chimeCtx
    // Autoplay policy can leave the context suspended until a gesture; the bell
    // toggle click already unlocked it, but resume() is harmless if already running.
    void ctx.resume()
    const now = ctx.currentTime
    ;[[880, 0], [1174.66, 0.15]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      // Quick attack, gentle decay — a soft bell, not a beep.
      gain.gain.setValueAtTime(0.0001, now + at)
      gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + at)
      osc.stop(now + at + 0.4)
    })
  } catch { /* WebAudio unavailable/blocked — no sound, no crash */ }
}

/** Activity-bar icon button — rounded tile, soft-fill active state. Used by
 *  the collapsed left rail; the expanded left column uses NavMenuItem. */
function ActivityBarButton({ active, onClick, title, children }: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-xl transition-colors',
        active
          ? 'bg-[var(--secondary)] text-[var(--primary)]'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
      )}
    >
      {children}
    </button>
  )
}

/** Left-column menu item with icon + label (WorkBuddy-style nav). */
function NavMenuItem({ icon: Icon, label, active, onClick }: {
  icon: typeof FolderTree
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
        active
          ? 'bg-[var(--secondary)] font-medium text-[var(--foreground)]'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

interface WorkspaceLayoutProps {
  linkState: LinkState
}

export function WorkspaceLayout({ linkState }: WorkspaceLayoutProps) {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const openFolder = useProjectStore((s) => s.openFolder)
  // Agent busy/idle + subscribed session for the dynamic window title +
  // finished-notification below. sessionId gates the notification so a
  // session switch can't be mistaken for the current agent finishing.
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sessionId = useChatStore((s) => s.sessionId)
  const [activeTab, setActiveTab] = useState<SidebarTab>(() => {
    if (typeof window === 'undefined') return 'explorer'
    const stored = localStorage.getItem('halo_sidebar_tab')
    // 'sessions' was removed from the nav (replaced by the always-on session
    // list + 新建任务) — land returning users on the workspace home.
    if (!stored || stored === 'sessions') return 'explorer'
    return stored as SidebarTab
  })
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('halo_sidebar_open') !== 'false'
  })
  // Left navigation column (menu + session list) — visibility lives in the
  // shared session controller so the chat composer's History button toggles
  // the same column.
  const leftNavOpen = useSessionController((s) => s.sidebarOpen)
  const setLeftNavOpen = useSessionController((s) => s.setSidebar)
  // Right canvas column collapse — local pref, collapsed by default (the chat
  // is the main surface; the canvas opens on demand via the rail).
  const [canvasOpen, setCanvasOpen] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_canvas_open') === 'true'
  })
  const toggleCanvas = useCallback((open: boolean) => {
    setCanvasOpen(open)
    try { localStorage.setItem('halo_canvas_open', String(open)) } catch { /* ignore */ }
  }, [])
  // Canvas view — overview (task progress + artifacts) / browser.
  const [canvasView, setCanvasView] = useState<'overview' | 'browser'>(() => {
    if (typeof window === 'undefined') return 'overview'
    const v = localStorage.getItem('halo_canvas_view')
    return v === 'browser' ? 'browser' : 'overview'
  })
  const changeCanvasView = useCallback((v: 'overview' | 'browser') => {
    setCanvasView(v)
    try { localStorage.setItem('halo_canvas_view', v) } catch { /* ignore */ }
  }, [])
  // 切换空间 — same folder-picker flow the old Explorer sidebar offered.
  const [showSpacePicker, setShowSpacePicker] = useState(false)

  // Always-on-top toggle — only present in the desktop shell (preload injects
  // window.haloPin). null = not desktop → button hidden. See preload.cjs.
  const [pinned, setPinned] = useState<boolean | null>(null)
  useEffect(() => {
    const pin = (window as unknown as { haloPin?: { get: () => Promise<boolean> } }).haloPin
    if (pin) void pin.get().then(setPinned)
  }, [])
  const togglePin = useCallback(() => {
    const pin = (window as unknown as { haloPin?: { toggle: () => Promise<boolean> } }).haloPin
    if (pin) void pin.toggle().then(setPinned)
  }, [])

  // Notify-on-finish toggle. Available when we can actually raise a
  // notification: the desktop shell (window.haloNotify, injected by preload) or
  // a plain browser that supports the Web Notification API. Off by default;
  // persisted per-machine in localStorage. false = neither → button hidden,
  // mirroring the pin toggle above. Lazy-initialized from localStorage like the
  // sidebar prefs, so no mount effect / setState.
  const notifyAvailable = typeof window !== 'undefined'
    && (!!(window as unknown as { haloNotify?: unknown }).haloNotify || 'Notification' in window)
  const [notifyOnFinish, setNotifyOnFinish] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('halo_notify_on_finish') === 'true'
  })
  const toggleNotify = useCallback(async () => {
    // Turning it ON in a plain browser needs Notification permission, and the
    // browser only grants requestPermission() from a user gesture — this click
    // is that gesture. Desktop (haloNotify) manages permission natively, so
    // skip the prompt there. If the user denied it, don't flip on (the toggle
    // would be a lie); the browser won't re-prompt until they reset it in site
    // settings.
    const isDesktop = !!(window as unknown as { haloNotify?: unknown }).haloNotify
    if (!notifyOnFinish && !isDesktop && 'Notification' in window) {
      let perm = Notification.permission
      if (perm === 'default') perm = await Notification.requestPermission()
      if (perm !== 'granted') return
    }
    setNotifyOnFinish((prev) => {
      const next = !prev
      try { localStorage.setItem('halo_notify_on_finish', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [notifyOnFinish])

  // Dynamic window title + finished-notification, driven by agent busy state.
  // Runs in every environment — document.title is harmless in a plain browser
  // (the tab label just tracks agent state too), and the notification fires
  // through the desktop bridge or the Web Notification API, whichever exists.
  const prevStreamingRef = useRef(isStreaming)
  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    const name = activeProject?.name
    // No workspace open → bare "元轴"; otherwise prefix a solid dot while busy.
    // em dash (U+2014) matches the desktop window/title style. The env-badge
    // prefix ("[DEV] ") must be re-stamped here — this rewrite would
    // otherwise clobber what applyEnvBadge put on the initial title.
    document.title = envBadgeTitlePrefix() + (name ? `${isStreaming ? '● ' : ''}元轴 — ${name}` : '元轴')

    // Busy→idle falling edge → notify the user their agent finished, but only
    // when this window is unfocused (focused → they can see it) AND the session
    // didn't change on this tick. isStreaming tracks the *currently subscribed*
    // session; switching sessions (loadSession sets sessionId but leaves
    // isStreaming until the new session's events recalibrate it) can drop it
    // true→false even though the old session is still running — that's a false
    // "finished", so a session change on the edge tick is not a real completion.
    const wasStreaming = prevStreamingRef.current
    const prevSessionId = prevSessionIdRef.current
    prevStreamingRef.current = isStreaming
    prevSessionIdRef.current = sessionId
    // Real busy→idle completion of the *still-subscribed* session.
    const finished = notifyOnFinish
      && wasStreaming && !isStreaming
      && prevSessionId === sessionId && sessionId != null
    if (finished) {
      // Sound plays regardless of focus — the whole point is an audible cue even
      // when you're looking at the tab (a native banner would be noise there, so
      // that still waits for blur below). Self-synthesized so there's no audio
      // asset to bundle; browsers/Electron gate WebAudio behind a prior user
      // gesture, which the bell toggle click already satisfied.
      playChime()
      if (!document.hasFocus()) {
        const title = name ? `元轴 — ${name}` : '元轴'
        const body = t('status.notifyBody')
        const notify = (window as unknown as {
          haloNotify?: { notify: (p: { title: string; body: string }) => void }
        }).haloNotify
        if (notify) {
          // Desktop: native banner + Dock/taskbar attention via the main process.
          notify.notify({ title, body })
        } else if ('Notification' in window && Notification.permission === 'granted') {
          // Browser: raise a Web Notification; clicking it refocuses this tab.
          const n = new Notification(title, { body })
          n.onclick = () => { window.focus(); n.close() }
        }
      }
    }
  }, [isStreaming, sessionId, activeProject?.name, t, notifyOnFinish])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const folder = params.get('folder')

    const resolveAndOpen = async (target: string, writeUrl: boolean) => {
      try {
        const ws = await api.fs.resolveWorkspace(target)
        openFolder(ws.path, ws.id)
        loadFileTree(ws.path)
        // Remember the opened folder so a launch without ?folder (the desktop
        // app's normal case) reopens here instead of bouncing to home.
        try { localStorage.setItem('halo_last_folder', ws.path) } catch { /* ignore */ }
        // Record in the recent-workspaces MRU list (dropdown in the Explorer path
        // input). Written here — the single point every successful switch funnels
        // through (URL ?folder, restored last-folder, and openFolderPath's post-reload
        // resolve) — so only validated paths land, in canonical (resolved) form.
        addRecentWorkspace(ws.path)
        if (writeUrl || ws.path !== target) {
          const url = new URL(window.location.href)
          url.searchParams.set('folder', ws.path)
          window.history.replaceState({}, '', url.toString())
        }
      } catch (err) {
        console.error('[Workspace] Failed to resolve workspace:', err)
        return false
      }
      return true
    }

    if (folder) {
      resolveAndOpen(folder, false)
    } else {
      // No folder in URL — reopen the last folder, falling back to home if
      // there's none stored or it no longer resolves (e.g. the dir was moved).
      const last = (() => { try { return localStorage.getItem('halo_last_folder') } catch { return null } })()
      const openHome = () => api.fs.home().then(({ home }) => resolveAndOpen(home, true)).catch((err) => {
        console.error('[Workspace] Failed to resolve home dir:', err)
      })
      if (last) {
        resolveAndOpen(last, true).then((ok) => { if (!ok) openHome() })
      } else {
        openHome()
      }
    }
  }, [])

  // Warn before closing/refreshing the page — but not for deliberate
  // workspace jumps: openFolderPath confirms unsaved edits itself (and only
  // when there are any), so the generic leave-site dialog on top of that
  // would be a second, redundant prompt on every switch.
  const suppressUnloadWarning = useRef(false)
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (suppressUnloadWarning.current) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Desktop shell Cmd/Ctrl+W: main.cjs swallows the native accelerator in
  // before-input-event and forwards over IPC (window.haloCloseShortcut,
  // preload-injected). There are no editor tabs to close anymore, so it
  // always means "close the window". Undefined in a plain browser.
  useEffect(() => {
    const bridge = (window as unknown as {
      haloCloseShortcut?: { onTrigger: (fn: () => void) => void; closeWindow: () => void }
    }).haloCloseShortcut
    if (!bridge) return
    bridge.onTrigger(() => bridge.closeWindow())
  }, [])

  // ESC exits editor maximize — skip when focus is in Monaco / inputs so they can handle ESC first
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (!useEditorStore.getState().maximized) return
      const el = document.activeElement as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return
        if (el.closest('.monaco-editor')) return
      }
      useEditorStore.getState().setMaximized(false)
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [])

  // Listen for cross-component navigation events (e.g. "Test" button in agent management)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.tab) return
      // When bottom panel is floating, Chat is already globally visible — skip the auto-jump to explorer
      const { bottomFloating } = useEditorStore.getState()
      if (bottomFloating && detail.tab === 'explorer') return
      setActiveTab(detail.tab as SidebarTab)
      setSidebarOpen(true)
    }
    window.addEventListener('halo:navigate', handler)
    return () => window.removeEventListener('halo:navigate', handler)
  }, [])

  // "Open as Workspace" from the file-tree context menu — switch the active
  // workspace to the right-clicked folder. openFolderPath has no state deps
  // (validate → persist → reload), so binding once with [] is safe.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path
      if (path) openFolderPath(path)
    }
    window.addEventListener('halo:open-workspace', handler)
    return () => window.removeEventListener('halo:open-workspace', handler)
  }, [])

  // Persist sidebar state to localStorage
  useEffect(() => {
    localStorage.setItem('halo_sidebar_tab', activeTab)
    localStorage.setItem('halo_sidebar_open', String(sidebarOpen))
  }, [activeTab, sidebarOpen])

  function handleTabClick(tab: SidebarTab) {
    // Switching activity tab always exits editor maximize (the maximize button lives in Explorer only)
    if (useEditorStore.getState().maximized) useEditorStore.getState().setMaximized(false)
    if (activeTab === tab && sidebarOpen) {
      setSidebarOpen(false)
    } else {
      setActiveTab(tab)
      setSidebarOpen(true)
    }
  }

  // Back to the workspace home (chat + canvas) — used by 新建任务 and by
  // clicking a session in the left list while on another tab.
  const goHome = useCallback(() => {
    if (useEditorStore.getState().maximized) useEditorStore.getState().setMaximized(false)
    setActiveTab('explorer')
  }, [])

  // 新建任务: start a fresh session and land on the workspace home.
  const newSession = useSessionController((s) => s.newSession)
  const handleNewTask = useCallback(() => {
    newSession()
    goHome()
  }, [newSession, goHome])

  // One jump at a time: a second call (Enter auto-repeat / double-fire,
  // double-click on a recent entry) while the first is validating or already
  // navigating would run the whole confirm→reload sequence again, stacking
  // dialogs. Never reset on the success path — the page is about to unload.
  const workspaceJumpInFlight = useRef(false)
  async function openFolderPath(target: string) {
    const path = target.trim()
    if (!path) return
    if (workspaceJumpInFlight.current) return
    workspaceJumpInFlight.current = true
    try {
      const res = await api.fs.exists(path)
      if (!res.exists || !res.isDirectory) {
        window.alert(`Workspace not found: ${path}`)
        workspaceJumpInFlight.current = false
        return
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to validate path')
      workspaceJumpInFlight.current = false
      return
    }
    // Deliberate navigation: confirm unsaved edits explicitly (only when any
    // exist), then suppress the generic leave-site warning — without this the
    // browser's beforeunload dialog fires on every switch, unsaved or not.
    const dirty = useEditorStore.getState().tabs.filter((t) => t.modified)
    if (dirty.length > 0) {
      const names = dirty.map((t) => t.path.split('/').pop()).join(', ')
      if (!(await confirmAction(`Unsaved changes in ${names} will be lost. Switch workspace anyway?`))) {
        workspaceJumpInFlight.current = false
        return
      }
    }
    suppressUnloadWarning.current = true
    // Remember this as the last folder BEFORE the reload, so a later launch
    // without ?folder (the desktop app's normal case) reopens here. Without
    // this, switching workspaces via this path never updated halo_last_folder
    // (only the startup resolveAndOpen did), so the app always bounced back to
    // the previously-recorded dir / home on restart.
    try { localStorage.setItem('halo_last_folder', path) } catch { /* ignore */ }
    // Update URL and full-reload so all state (editor tabs, WS, terminal, chat)
    // starts fresh for the new workspace. Persistent data (DB, .halo/*) is
    // keyed by stable workspace id, so switching back later restores it.
    const url = new URL(window.location.href)
    url.searchParams.set('folder', path)
    window.location.href = url.toString()
  }

  const tabs: { id: SidebarTab; icon: typeof FolderTree; label: string; position?: 'bottom' }[] = [
    { id: 'source-control', icon: GitBranch, label: t('nav.sourceControl') },
    { id: 'skills', icon: Zap, label: t('nav.skills') },
    { id: 'management', icon: Bot, label: t('nav.agents') },
    { id: 'channels', icon: MessageCircle, label: t('nav.channels') },
    { id: 'evolution', icon: Sparkles, label: t('nav.evolution') },
    { id: 'cron', icon: Clock, label: t('nav.cron') },
    { id: 'settings', icon: Settings2, label: t('nav.settings'), position: 'bottom' },
  ]

  const projectId = activeProject?.id ?? null
  // Keep the Explorer's git status decorations in sync for the active workspace.
  useGitDecorationsSync(projectId)
  // Hide the Source Control entry for non-git workspaces (spares non-developer
  // users a panel that doesn't apply). Three-state: show while 'unknown' (no
  // first-paint flicker) and when true (incl. a clean repo with no changes);
  // hide only on a confirmed non-repo. Reuses useGitDecorationsSync's status
  // call — no extra fetch.
  const isRepo = useIsRepo(projectId)

  const topTabs = tabs
    .filter((t) => t.position !== 'bottom')
    .filter((t) => t.id !== 'source-control' || isRepo !== false)
  const bottomTabs = tabs.filter((t) => t.position === 'bottom')
  const maximized = useEditorStore((s) => s.maximized)
  const bottomFloating = useEditorStore((s) => s.bottomFloating)
  const bottomMaximized = useEditorStore((s) => s.bottomMaximized)
  // Non-Explorer tabs use sidebarOpen + their own tab-has-sidebar flag
  const nonExplorerHasSidebar = TABS_WITH_SIDEBAR.includes(activeTab) && sidebarOpen && activeTab !== 'explorer'
  const isExplorer = activeTab === 'explorer'

  // localStorage can restore activeTab='source-control' into a non-git
  // workspace, where the entry is now hidden — leaving the main area on the SC
  // panel with no matching activity-bar icon. Fall back to Explorer, but only
  // on a confirmed non-repo (never 'unknown', so an in-flight status check
  // can't kick the user off the tab).
  useEffect(() => {
    if (isRepo === false && activeTab === 'source-control') setActiveTab('explorer')
  }, [isRepo, activeTab])

  // Bottom panel single-render: docked / maximized / floating used to each
  // render their own <BottomPanel> at a different React-tree position, so
  // switching mode unmounted one and mounted another. TerminalPanel keeps its
  // xterm instances in a component-local ref, so every remount re-ran reattach
  // (with a 2s create-fresh fallback) and spawned duplicate PTY sessions. Fix:
  // render BottomPanel exactly ONCE into a stable detached host via a portal,
  // then physically move that host between the three slots. The portal's React
  // parent never changes, so BottomPanel/TerminalPanel mount once and persist.
  const [bottomHost] = useState(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.className = 'h-full'
    return el
  })
  const bottomDragHandleRef = useRef<HTMLDivElement | null>(null)
  const [dockedBottomSlot, setDockedBottomSlot] = useState<HTMLDivElement | null>(null)
  const [overlayBottomSlot, setOverlayBottomSlot] = useState<HTMLDivElement | null>(null)
  const [floatingBottomSlot, setFloatingBottomSlot] = useState<HTMLDivElement | null>(null)
  const activeBottomSlot = bottomFloating ? floatingBottomSlot : bottomMaximized ? overlayBottomSlot : dockedBottomSlot
  useLayoutEffect(() => {
    if (bottomHost && activeBottomSlot && bottomHost.parentElement !== activeBottomSlot) {
      activeBottomSlot.appendChild(bottomHost)
    }
  }, [bottomHost, activeBottomSlot])

  return (
    <div className="flex h-full">
      {/* Left navigation column — menu (icon + label) + session list, WorkBuddy
          style. Collapses to an icon rail. Hidden when the editor is maximized. */}
      {leftNavOpen ? (
        <div className={cn('flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--card)]', maximized && 'hidden')}>
          <nav className="shrink-0 space-y-0.5 p-2">
            <NavMenuItem
              icon={ArrowLeftRight}
              label={t('nav.switchWorkspace')}
              onClick={() => setShowSpacePicker(true)}
            />
            <NavMenuItem
              icon={Plus}
              label={t('nav.newTask')}
              onClick={handleNewTask}
            />
            {topTabs.map((tab) => (
              <NavMenuItem
                key={tab.id}
                icon={tab.icon}
                label={tab.label}
                active={activeTab === tab.id}
                onClick={() => handleTabClick(tab.id)}
              />
            ))}
          </nav>
          {/* Session ("任务/对话") list — always on, WorkBuddy-style */}
          <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)]">
            <SessionNavSection onOpenSession={goHome} />
          </div>
          <div className="shrink-0 border-t border-[var(--border)] p-2">
            <div className="flex items-center gap-0.5 px-0.5">
              {bottomTabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <ActivityBarButton
                    key={tab.id}
                    active={activeTab === tab.id}
                    onClick={() => handleTabClick(tab.id)}
                    title={tab.label}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </ActivityBarButton>
                )
              })}
              {pinned !== null && (
                <ActivityBarButton
                  active={pinned}
                  onClick={togglePin}
                  title={pinned ? t('workspace.unpin') : t('workspace.pin')}
                >
                  {pinned ? <Pin className="h-4.5 w-4.5" /> : <PinOff className="h-4.5 w-4.5" />}
                </ActivityBarButton>
              )}
              {notifyAvailable && (
                <ActivityBarButton
                  active={notifyOnFinish}
                  onClick={() => void toggleNotify()}
                  title={notifyOnFinish ? t('workspace.notifyOn') : t('workspace.notifyOff')}
                >
                  {notifyOnFinish ? <Bell className="h-4.5 w-4.5" /> : <BellOff className="h-4.5 w-4.5" />}
                </ActivityBarButton>
              )}
              {/* Tri-state link light: green = inbound traffic fresh, amber =
                  OPEN but silent (probing), red = down/reconnecting. */}
              <div className="flex h-9 w-9 items-center justify-center" title={t(`link.${linkState}`)}>
                {linkState === 'fresh' ? <Wifi className="h-4 w-4 text-emerald-400" />
                  : linkState === 'stale' ? <Wifi className="h-4 w-4 text-amber-400 animate-pulse" />
                    : <WifiOff className="h-4 w-4 text-[var(--destructive)]" />}
              </div>
              <div className="flex-1" />
              <ActivityBarButton onClick={() => setLeftNavOpen(false)} title={t('sessions.collapse')}>
                <PanelLeftClose className="h-4.5 w-4.5" />
              </ActivityBarButton>
            </div>
          </div>
        </div>
      ) : (
        <div className={cn('flex w-12 shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--card)] py-2', maximized && 'hidden')}>
          <ActivityBarButton onClick={() => setLeftNavOpen(true)} title={t('sessions.expand')}>
            <PanelLeftOpen className="h-5 w-5" />
          </ActivityBarButton>
          <ActivityBarButton onClick={() => setShowSpacePicker(true)} title={t('nav.switchWorkspace')}>
            <ArrowLeftRight className="h-5 w-5" />
          </ActivityBarButton>
          <ActivityBarButton onClick={handleNewTask} title={t('nav.newTask')}>
            <Plus className="h-5 w-5" />
          </ActivityBarButton>
          {topTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <ActivityBarButton
                key={tab.id}
                active={activeTab === tab.id}
                onClick={() => handleTabClick(tab.id)}
                title={tab.label}
              >
                <Icon className="h-5 w-5" />
              </ActivityBarButton>
            )
          })}
          <div className="flex-1" />
          {bottomTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <ActivityBarButton
                key={tab.id}
                active={activeTab === tab.id}
                onClick={() => handleTabClick(tab.id)}
                title={tab.label}
              >
                <Icon className="h-5 w-5" />
              </ActivityBarButton>
            )
          })}
          {pinned !== null && (
            <ActivityBarButton
              active={pinned}
              onClick={togglePin}
              title={pinned ? t('workspace.unpin') : t('workspace.pin')}
            >
              {pinned ? <Pin className="h-5 w-5" /> : <PinOff className="h-5 w-5" />}
            </ActivityBarButton>
          )}
          {notifyAvailable && (
            <ActivityBarButton
              active={notifyOnFinish}
              onClick={() => void toggleNotify()}
              title={notifyOnFinish ? t('workspace.notifyOn') : t('workspace.notifyOff')}
            >
              {notifyOnFinish ? <Bell className="h-5 w-5" /> : <BellOff className="h-5 w-5" />}
            </ActivityBarButton>
          )}
          {/* Tri-state link light (see expanded column above). */}
          <div className="pb-1" title={t(`link.${linkState}`)}>
            {linkState === 'fresh' ? <Wifi className="h-4 w-4 text-emerald-400" />
              : linkState === 'stale' ? <Wifi className="h-4 w-4 text-amber-400 animate-pulse" />
                : <WifiOff className="h-4 w-4 text-[var(--destructive)]" />}
          </div>
        </div>
      )}

      {/* Explorer (workspace home) — chat center + right canvas column. Always
          mounted so the chat panel survives tab switches. */}
      <div className={cn(
        'flex min-w-0 flex-1',
        !isExplorer && 'hidden',
        maximized && 'fixed inset-0 z-40 bg-[var(--background)]',
      )}>
        <ExplorerSplitGroup
          showCenter={!bottomFloating && !maximized}
          showCanvas={canvasOpen}
          center={<div ref={setDockedBottomSlot} className="h-full" />}
          canvas={
            <div className="flex h-full flex-col bg-[var(--background)]">
              <CanvasHeader
                view={canvasView}
                onViewChange={changeCanvasView}
                onCollapse={() => toggleCanvas(false)}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">
                {canvasView === 'overview' && <CanvasOverview />}
                {canvasView === 'browser' && <CanvasBrowserView />}
              </div>
            </div>
          }
        />
        {/* Collapsed canvas rail — one click to bring the canvas back. */}
        {!canvasOpen && (
          <div className="flex w-11 shrink-0 flex-col items-center border-l border-[var(--border)] bg-[var(--card)] py-2">
            <ActivityBarButton onClick={() => toggleCanvas(true)} title={t('nav.canvas')}>
              <PanelRightOpen className="h-4 w-4" />
            </ActivityBarButton>
          </div>
        )}
      </div>

      {/* Other tabs — keep the original conditional-render behavior (they get destroyed/rebuilt on switch) */}
      {!isExplorer && !maximized && (
        nonExplorerHasSidebar ? (
          <PanelGroup direction="horizontal" autoSaveId="halo-h-sidebar" className="flex-1">
            <Panel defaultSize={22} minSize={15} maxSize={40}>
              <div className="h-full overflow-hidden">
                {activeTab === 'source-control' && <SourceControlSidebar />}
                {activeTab === 'skills' && <SkillsSidebar />}
                {activeTab === 'channels' && <ChannelsSidebar />}
                {activeTab === 'evolution' && <EvolutionSidebar />}
                {activeTab === 'cron' && <CronSidebar />}
              </div>
            </Panel>
            <PanelResizeHandle className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />
            <Panel defaultSize={78} minSize={40}>
              <NonExplorerMainArea activeTab={activeTab} />
            </Panel>
          </PanelGroup>
        ) : (
          <div className="flex-1 min-w-0 overflow-hidden">
            <NonExplorerMainArea activeTab={activeTab} />
          </div>
        )
      )}

      {/* 切换空间 — folder picker (same dialog the old Explorer sidebar used) */}
      {showSpacePicker && (
        <FolderPicker
          initialPath={activeProject?.path}
          onSelect={(p) => { setShowSpacePicker(false); openFolderPath(p) }}
          onClose={() => setShowSpacePicker(false)}
        />
      )}

      {/* Floating Chat + Terminal panel — the panel itself is portaled into
          this frame's slot (see bottomHost above), so floating is just another
          slot rather than a separate BottomPanel mount. */}
      {bottomFloating && (
        <FloatingBottomPanel slotRef={setFloatingBottomSlot} dragHandleRef={bottomDragHandleRef} />
      )}

      {/* Maximized bottom panel — full viewport like editor maximize. Empty
          slot; the single BottomPanel host is moved here while maximized. */}
      {bottomMaximized && !bottomFloating && (
        <div ref={setOverlayBottomSlot} className="fixed inset-0 z-50 bg-[var(--background)]" />
      )}

      {/* The one and only BottomPanel. Rendered once into a stable detached
          host that's relocated between the docked / maximized / floating slots
          — never unmounted on mode switch, so the terminal's xterm instances
          (and PTY sessions) survive. */}
      {bottomHost && createPortal(
        <BottomPanel floating={bottomFloating} dragHandleRef={bottomDragHandleRef} />,
        bottomHost,
      )}
    </div>
  )
}

/** Horizontal split: center (chat/terminal) + right canvas. The PanelGroup
 *  always renders; hidden columns collapse to 0 so the visible one takes the
 *  full width without remounting either side (keeps the docked bottom-panel
 *  slot alive). Center hides while the bottom panel floats or the editor is maximized; canvas
 *  hides via its collapse button. */
function ExplorerSplitGroup({ showCenter, showCanvas, center, canvas }: {
  showCenter: boolean
  showCanvas: boolean
  center: React.ReactNode
  canvas: React.ReactNode
}) {
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null)
  // Remember the last center/canvas split so restoring it feels natural —
  // the canvas is a secondary panel, so it defaults to ~1/4 of the width.
  const lastSplitRef = useRef<[number, number]>([76, 24])

  useEffect(() => {
    const group = groupRef.current
    if (!group) return
    if (showCenter && showCanvas) {
      group.setLayout(lastSplitRef.current)
      return
    }
    // Capture the current split before collapsing (only a real two-column
    // split is worth restoring).
    const current = group.getLayout() as [number, number]
    if (current[0] > 0 && current[1] > 0) lastSplitRef.current = current
    if (!showCenter && !showCanvas) return // transient — leave layout as-is
    group.setLayout(showCenter ? [100, 0] : [0, 100])
  }, [showCenter, showCanvas])

  const handleHidden = !showCenter || !showCanvas

  return (
    <PanelGroup ref={groupRef} direction="horizontal" autoSaveId="halo-h-canvas" className="flex-1">
      <Panel defaultSize={76} minSize={0} collapsible>
        <div className={cn('h-full', !showCenter && 'hidden')}>{center}</div>
      </Panel>
      <PanelResizeHandle className={cn(
        'w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors',
        handleHidden && 'pointer-events-none opacity-0',
      )} />
      <Panel defaultSize={24} minSize={0} collapsible>
        <div className={cn('h-full', !showCanvas && 'hidden')}>{canvas}</div>
      </Panel>
    </PanelGroup>
  )
}

/** Non-explorer tabs keep their original conditional-render behavior — destroyed/rebuilt each switch. */
function NonExplorerMainArea({ activeTab }: { activeTab: SidebarTab }) {
  if (activeTab === 'source-control') return <SourceControlMain />
  if (activeTab === 'management') return <AgentManagementMain />
  if (activeTab === 'skills') return <SkillsMain />
  if (activeTab === 'channels') return <ChannelsMain />
  if (activeTab === 'evolution') return <EvolutionMain />
  if (activeTab === 'cron') return <CronMain />
  if (activeTab === 'settings') return <SettingsMain />
  return null
}

type CanvasView = 'overview' | 'browser'

/** Canvas column header — WorkBuddy-style ☰ view switcher （概览 / 浏览器)
 *  plus the panel collapse control. */
function CanvasHeader({ view, onViewChange, onCollapse }: {
  view: CanvasView
  onViewChange: (v: CanvasView) => void
  onCollapse: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const views: { id: CanvasView; label: string }[] = [
    { id: 'overview', label: t('canvas.overview') },
    { id: 'browser', label: t('canvas.browser') },
  ]
  const current = views.find((v) => v.id === view)

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--card)] px-2">
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(!open)}
          title={t('nav.canvas')}
          className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Menu className="h-4 w-4" />
        </button>
        {open && (
          <div className="absolute left-0 top-full z-30 mt-1 min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
            {views.map((v) => (
              <button
                key={v.id}
                onClick={() => { onViewChange(v.id); setOpen(false) }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                  v.id === view ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]',
                )}
              >
                <span className="flex-1">{v.label}</span>
                {v.id === view && <Check className="h-3.5 w-3.5 text-[var(--primary)]" />}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="text-sm font-medium text-[var(--foreground)]">{current?.label}</span>
      <div className="flex-1" />
      <button
        onClick={onCollapse}
        title={t('sessions.collapse')}
        className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
      >
        <PanelRightClose className="h-4 w-4" />
      </button>
    </div>
  )
}

/** Simple browser view: address bar + iframe. Sites that send
 *  X-Frame-Options / frame-ancestors will refuse to render — the external
 *  button covers those. Last URL persists in localStorage. */
function CanvasBrowserView() {
  const t = useT()
  const [url, setUrl] = useState(() => {
    if (typeof window === 'undefined') return ''
    try { return localStorage.getItem('halo_canvas_browser_url') ?? '' } catch { return '' }
  })
  const [input, setInput] = useState(url)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const navigate = (target: string) => {
    let u = target.trim()
    if (!u) return
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`
    setUrl(u)
    setInput(u)
    try { localStorage.setItem('halo_canvas_browser_url', u) } catch { /* ignore */ }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] p-2">
        <button
          onClick={() => { if (iframeRef.current && url) iframeRef.current.src = url }}
          title="Reload"
          className="rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) navigate(input) }}
          placeholder={t('canvas.browserPlaceholder')}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2 py-1 text-xs text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
        />
        <button
          onClick={() => { if (url) window.open(url, '_blank', 'noopener') }}
          title={t('canvas.openExternal')}
          className="rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </div>
      {url ? (
        <iframe ref={iframeRef} src={url} title={t('canvas.browser')} className="min-h-0 flex-1 border-0 bg-white" />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
          <Globe className="h-8 w-8" />
          <span className="text-xs">{t('canvas.browserPlaceholder')}</span>
        </div>
      )}
    </div>
  )
}


