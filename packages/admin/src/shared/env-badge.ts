/**
 * Runtime environment badge (server `HALO_BADGE` env) — repaints the favicon
 * with a high-contrast label band and prefixes the tab title, so parallel
 * dev/prod admin tabs are tellable apart. dev and prod serve the same static
 * build, so this must be a runtime signal: it rides on the `badge` field of
 * GET /api/auth/check, the admin's first request (page.tsx applies it).
 *
 * No badge → nothing here runs; stock favicon/title stay byte-identical.
 */

let badge: string | null = null

/** `"[DEV] "` while a badge is active, `''` otherwise. workspace-layout
 *  prepends this whenever it rewrites document.title (its dynamic title
 *  effect would otherwise clobber the prefix applyEnvBadge stamped). */
export function envBadgeTitlePrefix(): string {
  return badge ? `[${badge}] ` : ''
}

/** Record the badge and brand the tab: prefix the current title and swap the
 *  favicon for a badged repaint. Null/blank → no-op. First badge wins —
 *  re-applies (React strict mode double-fires the fetching effect) are
 *  no-ops, and the value can't legitimately change without a server restart
 *  + tab reload anyway. */
export function applyEnvBadge(value: string | null | undefined): void {
  const next = typeof value === 'string' && value.trim() ? value.trim() : null
  if (!next || badge) return
  badge = next
  document.title = envBadgeTitlePrefix() + document.title
  // Band text caps at 4 chars — longer overflows the 16×16 band; the title
  // prefix above keeps the full value readable.
  swapFavicon(next.slice(0, 4))
}

/** Repaint the favicon: the halo mark drawn directly on a canvas (same
 *  palette as app/icon.svg — drawing beats decoding the SVG into an <img>:
 *  synchronous, no network, no cross-browser SVG-in-canvas quirks) with an
 *  orange-red band across the bottom, white bold label. Proportions chosen
 *  to stay legible after the browser downscales 64px → 16px. */
function swapFavicon(label: string): void {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Rounded-square dark backdrop (≈ icon.svg's squircle + bg gradient).
  // arcTo path instead of roundRect() — Safari < 16 lacks the latter.
  const r = size * 0.22
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.arcTo(size, 0, size, size, r)
  ctx.arcTo(size, size, 0, size, r)
  ctx.arcTo(0, size, 0, 0, r)
  ctx.arcTo(0, 0, size, 0, r)
  ctx.closePath()
  const bg = ctx.createLinearGradient(0, 0, size, size)
  bg.addColorStop(0, '#0e1430')
  bg.addColorStop(1, '#070a16')
  ctx.fillStyle = bg
  ctx.fill()
  ctx.clip() // keep rings and the band inside the rounded square

  // Halo rings + glowing core, shifted up into the space above the band.
  const cx = size / 2
  const cy = size * 0.33
  for (const [radius, alpha] of [[size * 0.14, 0.55], [size * 0.21, 0.3]] as const) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(125, 140, 255, ${alpha})`
    ctx.lineWidth = size * 0.035
    ctx.stroke()
  }
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.1)
  core.addColorStop(0, '#d8e6ff')
  core.addColorStop(1, '#8aa6ff')
  ctx.beginPath()
  ctx.arc(cx, cy, size * 0.1, 0, Math.PI * 2)
  ctx.fillStyle = core
  ctx.fill()

  // Bottom band: orange-red under white bold text — at 16×16 the band is
  // ~7px with ~5px glyphs, still an unmistakable "not prod" stripe.
  const bandH = size * 0.42
  ctx.fillStyle = '#e8401c'
  ctx.fillRect(0, size - bandH, size, bandH)
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let font = Math.round(bandH * 0.82)
  ctx.font = `bold ${font}px system-ui, sans-serif`
  const maxW = size * 0.92
  while (font > 8 && ctx.measureText(label).width > maxW) {
    font -= 1
    ctx.font = `bold ${font}px system-ui, sans-serif`
  }
  ctx.fillText(label, size / 2, size - bandH / 2 + 1)

  // Replace both stock <link rel="icon"> entries (favicon.ico + icon.svg) —
  // leaving either would let the browser keep picking the unbadged mark.
  document.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
  const link = document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/png'
  link.href = canvas.toDataURL('image/png')
  document.head.appendChild(link)
}
