/**
 * Guards for text that comes from outside the TUI (tool output, streaming
 * model text) before it is handed to a rendered block. Both helpers are pure
 * and shared by more than one render path — the chat blocks (`app.tsx` /
 * `messages.tsx`) and the `/log` viewer.
 */

/** ANSI escape sequences: OSC (BEL-terminated), CSI (SGR colors included), and
 *  any other two-byte escape. Matched before the C0 sweep below — stripping a
 *  bare ESC first would leave the parameter bytes behind as literal `[31m`. */
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQ_RE = /\x1b\][^\x07\n]*\x07|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
/** C0 controls except `\n` (CR is folded into `\n` first), plus DEL. */
// eslint-disable-next-line no-control-regex
const C0_RE = /[\x00-\x09\x0b-\x1f\x7f]/g

/**
 * Strip terminal-hostile bytes from a tool result.
 *
 * Tool output is arbitrary process stdout: pip/npm/curl/apt progress bars
 * redraw with `\r`, which rewinds the cursor to column 0 and overwrites the
 * `│ ` gutter plus the first half of the rendered line — and these blocks are
 * committed inside `<Static>`, so the damage is permanent in the scrollback.
 * BEL rings the bell (once per occurrence), `\t` makes ink's string-width
 * layout math disagree with the terminal's 8-column tab stops, and a foreign
 * `\x1b[0m` ends the block's dim styling mid-line.
 *
 * Colors are dropped rather than passed through: both render paths wrap the
 * text in their own styling (`dimColor` in the chat block, a hand-built ANSI
 * prefix in the log viewer), so foreign SGR can only ever break it.
 */
export function sanitizeToolOutput(s: string): string {
  return s
    .replace(ESCAPE_SEQ_RE, '')
    .replace(/\r\n?/g, '\n')
    // Fixed two-space expansion: tabs cannot survive (see above), and dropping
    // them outright would glue columnar output together.
    .replace(/\t/g, '  ')
    .replace(C0_RE, '')
}

/**
 * The tail of `text` that renders within `maxRows` terminal rows at `cols`
 * columns, counting soft-wrapped continuation rows.
 *
 * Used to cap the live (non-`<Static>`) streaming zone: once a frame's height
 * reaches the terminal's, ink switches to `clearTerminal` (`2J` + `3J` + `H`)
 * on every frame, and `3J` erases the scrollback — so an over-tall live zone
 * costs the user their shell history and rewrites the whole static output once
 * per token. Nothing is lost by capping: the complete text is committed into
 * `<Static>` when the turn's usage/complete event lands.
 *
 * Walks backwards from the end so the work is bounded by the row budget, not
 * by the length of the reply (this runs on every streamed token).
 */
export function tailByRows(text: string, cols: number, maxRows: number): string {
  const width = Math.max(1, cols)
  let rows = 1
  let col = 0
  for (let i = text.length - 1; i >= 0; i--) {
    const code = text.charCodeAt(i)
    if (code === 10 /* \n */) {
      rows++
      col = 0
    } else {
      // Rough width: CJK / fullwidth / emoji take two columns. Anything at or
      // above U+1100 counts as wide, which over-counts a few narrow scripts —
      // erring toward a shorter live zone is the safe direction.
      col += code >= 0x1100 ? 2 : 1
      if (col > width) {
        rows++
        col = 0
      }
    }
    if (rows > maxRows) {
      // Don't cut between the halves of a surrogate pair.
      let cut = i + 1
      if (cut < text.length && text.charCodeAt(cut) >= 0xdc00 && text.charCodeAt(cut) <= 0xdfff) cut++
      return text.slice(cut)
    }
  }
  return text
}
