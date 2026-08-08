import { PassThrough } from 'node:stream'

/**
 * Minimal pseudo-TTY for ink: a PassThrough that claims `isTTY` with fixed
 * dimensions. ink writes real frames to it (colors, borders, wrap/truncate
 * passes, clearTerminal fallbacks), so tests can assert on the actual bytes a
 * terminal would receive instead of on component internals.
 */
export interface FakeTty extends PassThrough {
  isTTY: true
  columns: number
  rows: number
  setRawMode(mode: boolean): FakeTty
  ref(): FakeTty
  unref(): FakeTty
}

export function fakeTty(columns = 80, rows = 24): FakeTty {
  const s = new PassThrough() as unknown as FakeTty
  s.isTTY = true
  s.columns = columns
  s.rows = rows
  s.setRawMode = () => s
  s.ref = () => s
  s.unref = () => s
  return s
}

/**
 * Collect everything written to a fake stdout.
 *
 * `reset()` drops what's been seen so far — needed for "is the modal gone?":
 * the reader returns accumulated output, so a modal's bytes linger forever
 * once written and `not.toContain(...)` on the running total would pass for
 * the wrong reason. Reset, press, then assert on freshly written frames.
 */
export function captureOutput(stream: PassThrough): (() => string) & { reset(): void } {
  let chunks: string[] = []
  stream.on('data', (c: Buffer | string) => chunks.push(c.toString()))
  const read = () => chunks.join('')
  return Object.assign(read, { reset() { chunks = [] } })
}

/** Drop ANSI escapes (OSC, CSI, two-byte) so a frame can be read as text. */
export function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

/** East-Asian-Wide / emoji ranges — enough for the CJK + emoji fixtures used
 *  here. (ink itself uses the `string-width` package, not reachable from this
 *  workspace's dependency tree.) */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
]

/** Rendered display width of a frame row (box-drawing stays single-width). */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x200d || cp === 0xfe0f) continue // ZWJ / variation selector
    w += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1
  }
  return w
}

/**
 * ink 7 render options every TUI test must pass.
 *
 * `interactive: true` is load-bearing, not a nicety: ink resolves
 * `interactive ?? (!isInCi && stdout.isTTY)`, and `is-in-ci` trips on a bare
 * `CI=true` (GitHub Actions sets it). Non-interactive ink "writes only the
 * final frame at unmount" — dynamic output is buffered in `lastOutput` and
 * never reaches stdout while the app runs, so on CI every frame assertion
 * either failed outright or, worse, passed vacuously against an empty string
 * (`expect('').not.toMatch(/\r/)`). Forcing interactive mode makes the fake
 * TTY behave the same everywhere; these tests exist precisely to assert on
 * live interactive frames.
 */
export const INK_TEST_OPTIONS = {
  patchConsole: false,
  exitOnCtrlC: false,
  interactive: true,
} as const

/**
 * Wait until ink has flushed pending render output to stdout, then let queued
 * async work (effects, harness promises, ink's own render throttle) drain.
 *
 * `waitUntilRenderFlush()` covers the render ink already knows about; the
 * extra macrotask hop covers state updates that a keypress kicks off
 * asynchronously (an effect → setState → another render). Deterministic on a
 * loaded CI runner, unlike a bare `setTimeout`.
 */
export async function flush(instance?: { waitUntilRenderFlush(): Promise<void> }): Promise<void> {
  if (instance) await instance.waitUntilRenderFlush()
  await new Promise((r) => setTimeout(r, 0))
  if (instance) await instance.waitUntilRenderFlush()
}

/**
 * Poll until `predicate` holds, or fail with `what` and the last frame seen.
 *
 * The keypress tests need this: ink dispatches a key synchronously, but the
 * modal it opens lands one or more async React commits later, so "press, wait
 * a fixed 90ms, assert" is a race that a slow runner loses. Polling turns the
 * wait into "as long as it actually takes, up to a generous ceiling" without
 * weakening what's asserted — the predicate IS the assertion, and a timeout
 * throws with the frame for diagnosis.
 */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  frame: () => string = () => '(not captured)',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.\nLast frame:\n${frame()}`)
}
