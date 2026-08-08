import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useArchiveStore, noteArchiveAnchor, loadOlderArchive } from '../src/features/chat/archive-store'
import { useProjectStore } from '../src/shared/stores/project-store'
import { api } from '../src/shared/api-client'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract: scroll-up archive loading walks a cursor DOWN from the anchor the
 * `state:snapshot` handed over, one immutable segment per step.
 *
 *  - the anchor is pinned per session: a re-subscribe / per-turn snapshot must
 *    not reset it and drop segments the user already pulled, and a segment
 *    archived while the session is open must not shift the numbering
 *  - the cursor is monotonically decreasing and stops at 0 ("no earlier")
 *  - segments are cached module-side: revisiting a session re-renders its
 *    history with ZERO requests (a committed segment file never changes)
 *  - a failed pull leaves the cursor where it is, so the row stays retryable
 *
 * Mutation check (must fail on revert): drop the same-session early return in
 * `noteArchiveAnchor` → the re-snapshot case goes red; drop the `loading` guard
 * in `loadOlderArchive` → the concurrent case double-pulls; drop `segmentCache`
 * → the cache-replay case goes red.
 */

const PROJECT = '/ws/arch'

function msg(id: string): ChatMessage {
  return { id, role: 'user', content: id, timestamp: 1 }
}

/** One message per segment, named after it, so prepend order is checkable. */
function segmentSpy() {
  return vi.spyOn(api.sessionLogs, 'archiveSegment').mockImplementation(
    async (_sessionId: string, n: number) => ({ messages: [msg(`seg${n}`)] }),
  )
}

function ids(): string[] {
  return useArchiveStore.getState().messages.map((m) => m.id)
}

beforeEach(() => {
  vi.restoreAllMocks()
  useArchiveStore.setState({ sessionId: null, anchor: 0, cursor: 0, messages: [], loading: false })
  useProjectStore.getState().openFolder(PROJECT)
})

describe('noteArchiveAnchor', () => {
  it('pins anchor + cursor from the snapshot', () => {
    noteArchiveAnchor('s_pin', 3)
    const s = useArchiveStore.getState()
    expect(s.sessionId).toBe('s_pin')
    expect(s.anchor).toBe(3)
    expect(s.cursor).toBe(3)
    expect(s.messages).toEqual([])
  })

  it('is a no-op for the same session — pulled segments survive a re-snapshot', async () => {
    const spy = segmentSpy()
    noteArchiveAnchor('s_idem', 2)
    await loadOlderArchive()
    expect(ids()).toEqual(['seg2'])

    // Re-subscribe (stale-link reconnect) AND a later compact bumping the count.
    noteArchiveAnchor('s_idem', 2)
    noteArchiveAnchor('s_idem', 5)

    const s = useArchiveStore.getState()
    expect(s.anchor).toBe(2)     // anchor pinned at open time
    expect(s.cursor).toBe(1)     // walk position kept
    expect(ids()).toEqual(['seg2'])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rebinds on a session switch', () => {
    noteArchiveAnchor('s_a', 4)
    useArchiveStore.setState({ messages: [msg('stale')] })
    noteArchiveAnchor('s_b', 1)

    const s = useArchiveStore.getState()
    expect(s.sessionId).toBe('s_b')
    expect(s.anchor).toBe(1)
    expect(s.cursor).toBe(1)
    expect(s.messages).toEqual([])
  })

  it('archiveCount 0 leaves the anchor at 0 (nothing to load)', async () => {
    const spy = segmentSpy()
    noteArchiveAnchor('s_none', 0)
    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('loadOlderArchive — the cursor walk', () => {
  it('walks down one segment at a time, prepending oldest-first', async () => {
    const spy = segmentSpy()
    noteArchiveAnchor('s_walk', 3)

    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(2)
    expect(ids()).toEqual(['seg3'])

    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(1)
    expect(ids()).toEqual(['seg2', 'seg3'])

    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(0)
    expect(ids()).toEqual(['seg1', 'seg2', 'seg3'])

    // Exhausted — further scroll triggers are no-ops, not request 0 / -1.
    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(0)
    expect(spy).toHaveBeenCalledTimes(3)
    expect(spy.mock.calls.map((c) => c[1])).toEqual([3, 2, 1])
  })

  it('re-visiting a session replays from cache with zero requests', async () => {
    const spy = segmentSpy()
    noteArchiveAnchor('s_cached', 2)
    await loadOlderArchive()
    await loadOlderArchive()
    expect(ids()).toEqual(['seg1', 'seg2'])
    expect(spy).toHaveBeenCalledTimes(2)

    // Open another session, then come back — same segments, no new traffic.
    noteArchiveAnchor('s_other', 0)
    noteArchiveAnchor('s_cached', 2)
    await loadOlderArchive()
    await loadOlderArchive()

    expect(ids()).toEqual(['seg1', 'seg2'])
    expect(useArchiveStore.getState().cursor).toBe(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a failed pull leaves the cursor put so the row stays retryable', async () => {
    const spy = vi.spyOn(api.sessionLogs, 'archiveSegment')
      .mockRejectedValueOnce(new Error('API error 500'))
      .mockResolvedValueOnce({ messages: [msg('seg1')] })
    noteArchiveAnchor('s_fail', 1)

    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(1)
    expect(useArchiveStore.getState().loading).toBe(false)
    expect(ids()).toEqual([])

    await loadOlderArchive()
    expect(useArchiveStore.getState().cursor).toBe(0)
    expect(ids()).toEqual(['seg1'])
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('concurrent triggers pull one segment, not two', async () => {
    const spy = segmentSpy()
    noteArchiveAnchor('s_race', 3)

    // The scroll listener and the button can both fire within one frame.
    await Promise.all([loadOlderArchive(), loadOlderArchive()])

    expect(spy).toHaveBeenCalledTimes(1)
    expect(useArchiveStore.getState().cursor).toBe(2)
    expect(ids()).toEqual(['seg3'])
  })

  it('does nothing without an open project', async () => {
    const spy = segmentSpy()
    useProjectStore.getState().setActiveProject(null)
    noteArchiveAnchor('s_noproj', 2)

    await loadOlderArchive()

    expect(spy).not.toHaveBeenCalled()
    expect(useArchiveStore.getState().cursor).toBe(2)
  })
})
