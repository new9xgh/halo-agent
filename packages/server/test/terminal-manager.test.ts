import { describe, it, expect, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { TerminalManager } from '../src/ws/terminal-manager.js'

/**
 * Contract (audit A-M3): terminal input/resize without a terminalId is
 * rejected — never routed to "whatever PTY happens to be first" in the global
 * registry. The old fallback (`terminals.values().next().value`) wasn't even
 * scoped to the calling connection's ownedIds, so with two admin windows an
 * id-less keystroke from one browser landed in the other browser's shell.
 * Every admin send site always includes terminalId (source + compiled desktop
 * bundle both checked), so nothing legitimate hits the rejection.
 *
 * Real PTYs, not mocks: node-pty is loaded via createRequire (invisible to
 * vi.mock), and the observable contract — which SHELL saw the bytes — is
 * exactly what the bug corrupted.
 */

interface Frame { type?: string; terminalId?: string; data?: string }

function fakeWs(): { ws: WebSocket; frames: Frame[] } {
  const frames: Frame[] = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(payload: string) { frames.push(JSON.parse(payload) as Frame) },
  }
  return { ws: ws as unknown as WebSocket, frames }
}

function outputFor(frames: Frame[], terminalId: string): string {
  return frames
    .filter((f) => f.type === 'terminal:output' && f.terminalId === terminalId)
    .map((f) => f.data ?? '')
    .join('')
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn() } catch { /* pty already gone */ }
  }
})

/** Two connections, one PTY each — the multi-admin-window setup the bug
 *  corrupted. Returns after both shells have produced their first output. */
async function spawnPair(idA: string, idB: string) {
  const a = fakeWs()
  const b = fakeWs()
  const mgrA = new TerminalManager(a.ws)
  const mgrB = new TerminalManager(b.ws)
  // A spawns FIRST → A's PTY is the global map's first entry, the one the
  // old fallback handed out to anyone.
  mgrA.start({ terminalId: idA, cols: 80, rows: 24, browserId: 'browser-a', workspacePath: '/tmp/ws-a' })
  mgrB.start({ terminalId: idB, cols: 80, rows: 24, browserId: 'browser-b', workspacePath: '/tmp/ws-b' })
  cleanups.push(() => { mgrA.close(idA); mgrB.close(idB) })
  await waitFor(() => outputFor(a.frames, idA).length > 0 && outputFor(b.frames, idB).length > 0, 'both shell prompts')
  return { a, b, mgrA, mgrB }
}

describe('terminal input/resize without terminalId (audit A-M3)', () => {
  it("id-less input is rejected — it must not land in another connection's PTY", async () => {
    const A = 'term-input-a'
    const B = 'term-input-b'
    const { a, b, mgrA, mgrB } = await spawnPair(A, B)

    // The bug: no id → the write went to the FIRST PTY in the global map,
    // which belongs to connection A. (PTY echo alone makes the marker visible
    // in A's output stream, so detection doesn't depend on command execution.)
    mgrB.writeInput(undefined, 'echo INTRUDER\r')

    // A proper id still works (guards against over-rejecting mutations).
    mgrB.writeInput(B, 'echo B-OWN\r')
    await waitFor(() => outputFor(b.frames, B).includes('B-OWN'), "B's own echo")

    // Complete a full round-trip through A AFTER the id-less write: a PTY
    // processes writes in order, so if INTRUDER had reached A's shell its
    // echo would be in the stream before this one.
    mgrA.writeInput(A, 'echo A-OWN\r')
    await waitFor(() => outputFor(a.frames, A).includes('A-OWN'), "A's own echo")

    expect(outputFor(a.frames, A)).not.toContain('INTRUDER')
    expect(outputFor(b.frames, B)).not.toContain('INTRUDER')
  }, 30_000)

  it("id-less resize is rejected — the first PTY keeps its size; an id'd resize still works", async () => {
    const A = 'term-resize-a'
    const B = 'term-resize-b'
    const { a, b, mgrA, mgrB } = await spawnPair(A, B)

    // Old fallback would have resized A's PTY (first in the map) to 33×11.
    mgrB.resize(undefined, 33, 11)
    // With an id, resize must still reach the right PTY.
    mgrB.resize(B, 100, 30)

    // `stty size` prints "rows cols" for the shell's OWN PTY — the ground
    // truth for which kernel terminal actually got resized.
    mgrA.writeInput(A, 'stty size\r')
    await waitFor(() => outputFor(a.frames, A).includes('24 80'), "A's stty size (unchanged)")
    expect(outputFor(a.frames, A)).not.toContain('11 33')

    mgrB.writeInput(B, 'stty size\r')
    await waitFor(() => outputFor(b.frames, B).includes('30 100'), "B's stty size (resized)")
  }, 30_000)
})
