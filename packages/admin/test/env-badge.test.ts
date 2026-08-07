import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Contract: the runtime env badge (server HALO_BADGE via /api/auth/check)
 * brands the tab — favicon swapped for a badged repaint (stock icon links
 * replaced by one data-URL link) and the title gets a `[BADGE] ` prefix,
 * with the band label truncated to 4 chars. No badge → title and icon
 * links stay byte-identical (prod behavior unchanged).
 *
 * jsdom ships no 2D canvas backend (getContext returns null without the
 * native `canvas` package), so the context + toDataURL are stubbed with
 * just the surface env-badge draws through.
 */

const STOCK_TITLE = 'Halo - Multi-Agent Workspace'

function stubCanvas() {
  const fillText = vi.fn()
  const gradient = () => ({ addColorStop: vi.fn() })
  const ctx = {
    beginPath: vi.fn(), moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(),
    fill: vi.fn(), clip: vi.fn(), arc: vi.fn(), stroke: vi.fn(),
    fillRect: vi.fn(), fillText,
    measureText: vi.fn(() => ({ width: 10 })),
    createLinearGradient: vi.fn(gradient),
    createRadialGradient: vi.fn(gradient),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    textAlign: '', textBaseline: '', font: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,badged')
  return { fillText }
}

function iconLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')]
}

/** Fresh module (badge is module-level state) + stock head/title, mirroring
 *  the exported page: favicon.ico + icon.svg links. */
async function freshBadgeModule() {
  vi.resetModules()
  document.title = STOCK_TITLE
  document.head.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
  for (const [href, type] of [['/favicon.ico', 'image/x-icon'], ['/icon.svg', 'image/svg+xml']]) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = href
    link.type = type
    document.head.appendChild(link)
  }
  return import('../src/shared/env-badge')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('applyEnvBadge', () => {
  it('badge set → title prefixed and both stock icon links replaced by a badged data-URL icon', async () => {
    const mod = await freshBadgeModule()
    stubCanvas()

    mod.applyEnvBadge('DEV')

    expect(document.title).toBe(`[DEV] ${STOCK_TITLE}`)
    expect(mod.envBadgeTitlePrefix()).toBe('[DEV] ')
    const links = iconLinks()
    expect(links).toHaveLength(1)
    expect(links[0].href).toBe('data:image/png;base64,badged')
    expect(links[0].type).toBe('image/png')
  })

  it('band label uses the badge value verbatim, truncated to 4 chars', async () => {
    const mod = await freshBadgeModule()
    const { fillText } = stubCanvas()

    mod.applyEnvBadge('STAGING')

    expect(fillText).toHaveBeenCalledTimes(1)
    expect(fillText.mock.calls[0][0]).toBe('STAG')
    // Title keeps the full value — that's what rescues long badges the
    // 16×16 band can't fit.
    expect(document.title).toBe(`[STAGING] ${STOCK_TITLE}`)
  })

  it('no badge (null / undefined / blank) → title and icon links untouched', async () => {
    const mod = await freshBadgeModule()
    stubCanvas()

    mod.applyEnvBadge(null)
    mod.applyEnvBadge(undefined)
    mod.applyEnvBadge('   ')

    expect(document.title).toBe(STOCK_TITLE)
    expect(mod.envBadgeTitlePrefix()).toBe('')
    expect(iconLinks().map((l) => new URL(l.href).pathname)).toEqual(['/favicon.ico', '/icon.svg'])
  })

  it('re-apply is a no-op (strict-mode double effect) — title not double-prefixed', async () => {
    const mod = await freshBadgeModule()
    stubCanvas()

    mod.applyEnvBadge('DEV')
    mod.applyEnvBadge('DEV')

    expect(document.title).toBe(`[DEV] ${STOCK_TITLE}`)
    expect(iconLinks()).toHaveLength(1)
  })
})
