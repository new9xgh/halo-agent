import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'
import { createElement as h } from 'react'
import { render } from 'ink'
import { fakeTty, captureOutput, stripAnsi, flush } from './fixtures/fake-tty.js'

// The TUI persists input history to ~/.halo/global/tui-history.json; a test
// that submits a message must not append to the developer's real history.
vi.mock('../src/tui/history.js', () => ({
  loadHistory: () => [],
  appendHistory: () => {},
}))

const { App } = await import('../src/tui/app.js')
import type { Harness, SessionTreeNode } from '../src/harness.js'
import type { AgentSessionEvent } from '@turmind/halo-server/agents/agent-events'

/**
 * Contract (audit E-H1): ink dispatches every key to EVERY mounted `useInput`
 * handler — there is no capture or bubbling. So the app-level
 * "Esc interrupts the running turn" handler must explicitly stand down
 * whenever a modal owns Esc for itself:
 *
 *   - log viewer open  → Esc closes the viewer only
 *   - log navigator open → Esc closes the navigator only (its own header
 *     advertises "Esc/q to cancel")
 *   - completion popup open → Esc dismisses the popup only
 *
 * Mutation check (each verified red when reverted): remove any one of
 * `!viewer` / `!navTree` / `!popupOpen` from the guard in app.tsx and the
 * matching "does not interrupt" test below fails.
 */

interface Stub {
  harness: Harness
  interrupts: () => number
}

function stubHarness(): Stub {
  let interrupts = 0
  const handlers = new Set<(e: AgentSessionEvent) => void>()
  const tree: SessionTreeNode = {
    id: 'cli_root', agentName: 'dev', status: 'running', children: [],
  } as unknown as SessionTreeNode
  const harness = {
    sessionId: 'cli_root',
    workspace: os.tmpdir(),
    lang: 'en',
    supportsImage: false,
    run: async function* () { /* unused */ },
    send: async () => 'running' as const,
    onEvent: (fn: (e: AgentSessionEvent) => void) => { handlers.add(fn) },
    offEvent: (fn: (e: AgentSessionEvent) => void) => { handlers.delete(fn) },
    command: async () => null,
    interrupt: () => { interrupts++ },
    stop: async () => {},
    destroy: () => {},
    switchWorkspace: async () => {},
    getSessionTree: () => tree,
    // One tool message so the viewer has a line to show (an empty log makes
    // handleNavPick bail with "has no log" instead of opening the viewer).
    getSessionMessages: async () => [{ toolName: 'shell_exec', toolOutput: 'ok', timestamp: 0 }],
    isSessionRunning: () => true,
    listCommands: async () => [
      { name: 'help', slashName: '/help', description: 'show help', type: 'client', source: 'builtin' },
      { name: 'history', slashName: '/history', description: 'show history', type: 'client', source: 'builtin' },
    ],
    getMaxContextTokens: async () => 200_000,
  } as unknown as Harness
  return { harness, interrupts: () => interrupts }
}

/** Mount App on a pseudo-TTY and drive it by writing raw key bytes to stdin. */
async function mountApp() {
  const stdout = fakeTty(100, 30)
  const read = captureOutput(stdout)
  const stdin = fakeTty()
  const stub = stubHarness()
  const app = render(h(App, { harness: stub.harness, verbose: false }), {
    stdout, stdin, patchConsole: false, exitOnCtrlC: false,
  })
  await flush(120)
  const press = async (bytes: string, wait = 90) => {
    stdin.write(bytes)
    await flush(wait)
  }
  let exited = false
  app.waitUntilExit().then(() => { exited = true }, () => { exited = true })
  return {
    press,
    frame: () => stripAnsi(read()),
    interrupts: stub.interrupts,
    exited: () => exited,
    async done() {
      app.unmount()
      await app.waitUntilExit()
    },
  }
}

const ESC = '\x1b'
const ENTER = '\r'
const CTRL_O = '\x0f'

/** Get the app into `running` state the way a real turn does: submit a message
 *  whose `send()` resolves to 'running'. */
async function startTurn(t: Awaited<ReturnType<typeof mountApp>>) {
  await t.press('hello')
  await t.press(ENTER, 140)
}

describe('E-H1 — Esc while a modal is open must not interrupt the turn', () => {
  beforeEach(() => { /* each test mounts its own ink instance */ })

  it('baseline: Esc with nothing open DOES interrupt the running turn', async () => {
    const t = await mountApp()
    await startTurn(t)
    expect(t.interrupts()).toBe(0)
    await t.press(ESC)
    expect(t.interrupts()).toBe(1)
    expect(t.frame()).toContain('interrupting')
    await t.done()
  })

  it('log navigator open: Esc closes it and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.press(CTRL_O)
    expect(t.frame()).toContain('Session log')
    await t.press(ESC)
    expect(t.interrupts()).toBe(0)
    // Navigator gone → the input box (and its hint) is back.
    expect(t.frame()).toContain('esc to interrupt')
    // …and Esc now reaches the interrupt handler again.
    await t.press(ESC)
    expect(t.interrupts()).toBe(1)
    await t.done()
  })

  it('log viewer open: Esc closes it and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.press(CTRL_O)
    await t.press(ENTER, 160) // pick the root session → viewer opens
    expect(t.frame()).toContain('q to close')
    await t.press(ESC)
    expect(t.interrupts()).toBe(0)
    await t.done()
  })

  it('completion popup open: Esc dismisses the popup and leaves the turn running', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.press('/h')
    expect(t.frame()).toContain('show help')
    await t.press(ESC)
    expect(t.interrupts()).toBe(0)
    // Second Esc — popup already dismissed, so this one interrupts.
    await t.press(ESC)
    expect(t.interrupts()).toBe(1)
    await t.done()
  })

  it('Ctrl+C is unaffected by the guard — still exits (twice) with a modal open', async () => {
    const t = await mountApp()
    await startTurn(t)
    await t.press(CTRL_O)
    await t.press('\x03')
    expect(t.exited()).toBe(false)
    await t.press('\x03')
    expect(t.exited()).toBe(true)
    expect(t.interrupts()).toBe(0)
    await t.done()
  })
})
