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

/** Collect everything written to a fake stdout. */
export function captureOutput(stream: PassThrough): () => string {
  const chunks: string[] = []
  stream.on('data', (c: Buffer | string) => chunks.push(c.toString()))
  return () => chunks.join('')
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

/** Let ink's React commits + throttled frame writes settle. */
export function flush(ms = 120): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
