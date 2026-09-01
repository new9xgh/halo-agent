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

/** Repaint the favicon: the app icon (app/icon.png, served at /icon.png)
 *  with an orange-red band across the bottom, white bold label. Async image
 *  load — if the icon can't be fetched we keep the stock favicon (the title
 *  prefix still carries the badge). */
function swapFavicon(label: string): void {
  const img = new Image()
  img.onload = () => {
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Icon, shrunk slightly so the band doesn't cover its lower edge.
    ctx.drawImage(img, 0, 0, size, size * 0.62)

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

    // Replace the stock <link rel="icon"> entries (favicon.ico + icon.png) —
    // leaving either would let the browser keep picking the unbadged mark.
    document.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    link.href = canvas.toDataURL('image/png')
    document.head.appendChild(link)
  }
  img.src = '/icon.png'
}
