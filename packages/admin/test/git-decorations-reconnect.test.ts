import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from '../src/shared/api-client'
import { useGitDecorationsSync } from '../src/features/explorer/git-decorations'

/**
 * Contract: Explorer git decorations refresh on `file:changed` deltas, so a
 * stage/commit/edit that happened while the socket was down never repaints
 * them — until reconnect reconciliation (`onWsReconnect` → the hook's existing
 * `refresh`) refetches status + ignored.
 *
 * The hook subscribes to the wsClient *singleton*, so unlike
 * file-tree-reconnect.test.ts's parameter-injected fake, this fake replaces
 * the module via vi.mock — same shape, different seam.
 */

const { fakeWs } = vi.hoisted(() => {
  const handlers = new Map<string, Array<(data: Record<string, unknown>) => void>>()
  return {
    fakeWs: {
      // Subscribed while the socket is open → the next _connected IS a reconnect.
      connected: true,
      on(type: string, handler: (data: Record<string, unknown>) => void) {
        const list = handlers.get(type) ?? []
        list.push(handler)
        handlers.set(type, list)
        return () => {
          const cur = handlers.get(type) ?? []
          handlers.set(type, cur.filter((h) => h !== handler))
        }
      },
      emit(type: string) {
        ;(handlers.get(type) ?? []).forEach((h) => h({}))
      },
      reset() {
        handlers.clear()
      },
    },
  }
})

vi.mock('@/shared/ws-client', () => ({ wsClient: fakeWs }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Minimal hook harness — no @testing-library dependency. */
function mountHook(projectId: string): () => void {
  function Probe() {
    useGitDecorationsSync(projectId)
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Probe)))
  return () => act(() => root.unmount())
}

const PROJECT = '/ws/deco'

beforeEach(() => {
  vi.restoreAllMocks()
  fakeWs.reset()
})

describe('git decorations: reconnect → refetch', () => {
  it('reconnect triggers the same status+ignored refresh the deltas drive', async () => {
    const statusSpy = vi.spyOn(api.git, 'status').mockResolvedValue({
      isRepo: true, branch: 'main', tracking: null, ahead: 0, behind: 0, files: [],
    })
    const ignoredSpy = vi.spyOn(api.git, 'ignored').mockResolvedValue({ ignored: [] })

    const unmount = mountHook(PROJECT)
    // Mount fetch (existing behavior, not the reconnect path).
    await vi.waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1))

    // Reconnect — refetch both, immediately (no 400ms delta debounce involved).
    act(() => fakeWs.emit('_connected'))
    await vi.waitFor(() => {
      expect(statusSpy).toHaveBeenCalledTimes(2)
      expect(ignoredSpy).toHaveBeenCalledTimes(2)
    })
    unmount()
  })

  it('unmount unsubscribes the reconnect watcher too', async () => {
    const statusSpy = vi.spyOn(api.git, 'status').mockResolvedValue({
      isRepo: true, branch: 'main', tracking: null, ahead: 0, behind: 0, files: [],
    })
    vi.spyOn(api.git, 'ignored').mockResolvedValue({ ignored: [] })

    const unmount = mountHook(PROJECT)
    await vi.waitFor(() => expect(statusSpy).toHaveBeenCalledTimes(1))
    unmount()

    act(() => fakeWs.emit('_connected'))
    await new Promise((r) => setTimeout(r, 20))
    expect(statusSpy).toHaveBeenCalledTimes(1)
  })
})
