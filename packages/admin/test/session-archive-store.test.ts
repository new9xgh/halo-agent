import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionArchiveStore, anchorSessionArchive, loadOlderSessionArchive } from '../src/features/agents/session-archive-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import { api } from '../src/shared/api-client'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract: the Sessions-tab twin of the chat archive walk (see
 * archive-store.test.ts) — anchored from the session-log GET instead of the
 * subscribe snapshot, and deliberately cache-less: a selection switch drops
 * the walk entirely (cursor, pulled messages), and a pull that lands after
 * the walk moved on is discarded.
 */

const PROJECT = '/ws/sess-arch'

function msg(id: string): ChatMessage {
  return { id, role: 'user', content: id, timestamp: 1 }
}

function segmentSpy() {
  return vi.spyOn(api.sessionLogs, 'archiveSegment').mockImplementation(
    async (_sessionId: string, n: number) => ({ messages: [msg(`seg${n}`)] }),
  )
}

function ids(): string[] {
  return useSessionArchiveStore.getState().messages.map((m) => m.id)
}

beforeEach(() => {
  vi.restoreAllMocks()
  useSessionArchiveStore.setState({ sessionId: null, anchor: 0, cursor: 0, messages: [], loading: false })
  useProjectStore.getState().openFolder(PROJECT)
})

describe('anchorSessionArchive', () => {
  it('same session + same count is a no-op — a refetch re-anchor keeps pulled segments', async () => {
    segmentSpy()
    anchorSessionArchive('s_idem', 2)
    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg2'])

    anchorSessionArchive('s_idem', 2)
    anchorSessionArchive('s_idem', 0)

    const s = useSessionArchiveStore.getState()
    expect(s.anchor).toBe(2)
    expect(s.cursor).toBe(1)
    expect(ids()).toEqual(['seg2'])
  })

  it('a higher count re-anchors (mid-view compact) — walk restarts', async () => {
    segmentSpy()
    anchorSessionArchive('s_bump', 2)
    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg2'])

    anchorSessionArchive('s_bump', 3)
    const s = useSessionArchiveStore.getState()
    expect(s.cursor).toBe(3)
    expect(ids()).toEqual([])
  })

  it('a selection switch rebinds and drops the previous walk', async () => {
    segmentSpy()
    anchorSessionArchive('s_a', 2)
    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg2'])

    anchorSessionArchive('s_b', 1)
    const s = useSessionArchiveStore.getState()
    expect(s.sessionId).toBe('s_b')
    expect(s.anchor).toBe(1)
    expect(s.cursor).toBe(1)
    expect(s.messages).toEqual([])
  })
})

describe('loadOlderSessionArchive', () => {
  it('walks down one segment per call, prepending oldest-first, stopping at 0', async () => {
    const spy = segmentSpy()
    anchorSessionArchive('s_walk', 2)

    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg2'])
    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg1', 'seg2'])
    await loadOlderSessionArchive() // exhausted — no request 0
    expect(useSessionArchiveStore.getState().cursor).toBe(0)
    expect(spy.mock.calls.map((c) => c[1])).toEqual([2, 1])
  })

  it('a pull landing after a selection switch is discarded', async () => {
    let release!: (v: { messages: ChatMessage[] }) => void
    vi.spyOn(api.sessionLogs, 'archiveSegment').mockImplementation(
      () => new Promise((resolve) => { release = resolve }),
    )
    anchorSessionArchive('s_old', 1)
    const pull = loadOlderSessionArchive()

    anchorSessionArchive('s_new', 2) // switch while in flight
    release({ messages: [msg('stale')] })
    await pull

    const s = useSessionArchiveStore.getState()
    expect(s.sessionId).toBe('s_new')
    expect(s.cursor).toBe(2)
    expect(s.messages).toEqual([])
  })

  it('a failed pull leaves the cursor put so the gesture stays retryable', async () => {
    vi.spyOn(api.sessionLogs, 'archiveSegment')
      .mockRejectedValueOnce(new Error('API error 500'))
      .mockResolvedValueOnce({ messages: [msg('seg1')] })
    anchorSessionArchive('s_fail', 1)

    await loadOlderSessionArchive()
    expect(useSessionArchiveStore.getState().cursor).toBe(1)
    expect(useSessionArchiveStore.getState().loading).toBe(false)

    await loadOlderSessionArchive()
    expect(ids()).toEqual(['seg1'])
    expect(useSessionArchiveStore.getState().cursor).toBe(0)
  })

  it('concurrent triggers pull one segment, not two', async () => {
    const spy = segmentSpy()
    anchorSessionArchive('s_race', 3)

    await Promise.all([loadOlderSessionArchive(), loadOlderSessionArchive()])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(useSessionArchiveStore.getState().cursor).toBe(2)
  })
})
