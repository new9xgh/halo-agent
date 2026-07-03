// v3 palette: EDG32 at the core (deliberately spaced hues = cohesive pixel
// art), extended with material ramps for the street's architecture and a
// keyframed sky that runs on real local time.
//
// Design language: a dense little CITY BLOCK at dusk — warm interiors, cool
// night air, neon signage. No bloom anywhere; bright pixels are the lights.
import { fnv } from './util.js'

export const C = {
  // EDG32
  brownRed: '#be4a2f', brownOrange: '#d77643', cream: '#ead4aa', tan: '#e4a672',
  brown: '#b86f50', darkBrown: '#733e39', espresso: '#3e2731',
  darkRed: '#a22633', red: '#e43b44', orange: '#f77622', amber: '#feae34', yellow: '#fee761',
  green: '#63c74d', grass: '#3e8948', forest: '#265c42', pine: '#193c3e',
  navy: '#124e89', blue: '#0099db', cyan: '#2ce8f5',
  white: '#ffffff', ice: '#c0cbdc', steel: '#8b9bb4', slate: '#5a6988',
  dusk: '#3a4466', indigo: '#262b44', ink: '#181425',
  hotPink: '#ff0044', purple: '#68386c', mauve: '#b55088', salmon: '#f6757a',
  skin1: '#ffe0c2', skin2: '#e8b796', skin3: '#c28569', skin4: '#9b6a4a', skin5: '#7a4f35',
  outline: '#241a20',   // warm near-black for the citizen silhouette edge
}

// Color math is called thousands of times per frame from the render loop, so
// every function below is memoized. Inputs recur heavily (a handful of base
// colors × a handful of amounts), so hit rates are ~100% after the first
// frame; the caps only guard against a pathological input churn.
const _rgbCache = new Map()
function rgbOf(hex) {
  let v = _rgbCache.get(hex)
  if (v === undefined) {
    const n = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex
    v = [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)]
    if (_rgbCache.size > 4096) _rgbCache.clear()
    _rgbCache.set(hex, v)
  }
  return v
}
const _hex2 = []
for (let i = 0; i < 256; i++) _hex2.push(i.toString(16).padStart(2, '0'))
const toHex = (r, g, b) => `#${_hex2[r]}${_hex2[g]}${_hex2[b]}`

// Two-level maps (hex → amount → result) rather than concatenated string
// keys: number-keyed lookups allocate nothing, so the hot path is GC-free.
const _sub = (outer, key) => {
  let m = outer.get(key)
  if (m === undefined) {
    if (outer.size > 512) outer.clear()
    outer.set(key, (m = new Map()))
  }
  return m
}
const _shadeCache = new Map()
export function shade(hex, amt) {
  const m = _sub(_shadeCache, hex)
  let v = m.get(amt)
  if (v === undefined) {
    const [r, g, b] = rgbOf(hex)
    const f = (c) => Math.max(0, Math.round(c * (1 - amt)))
    v = toHex(f(r), f(g), f(b))
    if (m.size > 512) m.clear()
    m.set(amt, v)
  }
  return v
}
const _tintCache = new Map()
export function tint(hex, amt) {
  const m = _sub(_tintCache, hex)
  let v = m.get(amt)
  if (v === undefined) {
    const [r, g, b] = rgbOf(hex)
    const f = (c) => Math.min(255, Math.round(c + (255 - c) * amt))
    v = toHex(f(r), f(g), f(b))
    if (m.size > 512) m.clear()
    m.set(amt, v)
  }
  return v
}
const _alphaCache = new Map()
export function alpha(hex, a) {
  // Quantize to 8-bit alpha before keying: canvas color strings are parsed to
  // 8-bit channels anyway, so this is bit-identical — and it collapses the
  // animated call sites (per-star twinkle, per-wave shimmer) from unbounded
  // float inputs into ≤256 buckets per color.
  const q = (a * 255 + 0.5) | 0
  const m = _sub(_alphaCache, hex)
  let v = m.get(q)
  if (v === undefined) {
    const [r, g, b] = rgbOf(hex)
    v = `rgba(${r},${g},${b},${q / 255})`
    m.set(q, v)                    // bounded: q ∈ 0..255
  }
  return v
}
const _mixCache = new Map()
export function mix(ha, hb, t) {
  const m = _sub(_sub(_mixCache, ha), hb)
  let v = m.get(t)
  if (v === undefined) {
    const a = rgbOf(ha), b = rgbOf(hb)
    const f = (i) => Math.round(a[i] * (1 - t) + b[i] * t)
    v = toHex(f(0), f(1), f(2))
    if (m.size > 512) m.clear()
    m.set(t, v)
  }
  return v
}

export const STATUS_COLOR = { running: '#63c74d', idle: '#feae34', stopped: '#5a6988' }

// ── Building materials ──────────────────────────────────────────────────
// Each workspace's building rolls a material + trim from its key. `base` is
// the outer wall, `lo` its shadow, `hi` its lit edge; `frame` trims windows.
const MATERIALS = [
  { name: 'brick',    base: '#9e4a3a', lo: '#7c3a2e', hi: '#b95c46', frame: '#3e2731', mortar: '#6e3328' },
  { name: 'sandstone',base: '#c8a878', lo: '#a98b5e', hi: '#dcc093', frame: '#5e4a30', mortar: '#a3865c' },
  { name: 'concrete', base: '#8b8fa3', lo: '#6f7287', hi: '#a3a7bb', frame: '#3a4466', mortar: '#787c91' },
  { name: 'slate',    base: '#5a6988', lo: '#475372', hi: '#6e7e9d', frame: '#262b44', mortar: '#4a5575' },
  { name: 'copper',   base: '#7a5648', lo: '#5f4338', hi: '#92695a', frame: '#3e2731', mortar: '#64463a' },
  { name: 'teal',     base: '#3d7068', lo: '#2f5852', hi: '#4d8a80', frame: '#193c3e', mortar: '#346058' },
]
export function material(key) { return MATERIALS[fnv(key) % MATERIALS.length] }

// Interior themes (per building): back wall, wainscot, floorboards, accent.
const INTERIORS = [
  { wall: '#8a7460', wains: '#6f5c4b', floor: '#a9824f', floorLo: '#8c6b40', accent: '#feae34' },
  { wall: '#677892', wains: '#535f78', floor: '#7d8fab', floorLo: '#65748d', accent: '#2ce8f5' },
  { wall: '#7d8a61', wains: '#65724e', floor: '#97ad72', floorLo: '#7b8f5c', accent: '#63c74d' },
  { wall: '#83708d', wains: '#6a5a74', floor: '#97809f', floorLo: '#7b6883', accent: '#b55088' },
  { wall: '#9a8a6c', wains: '#7d6f55', floor: '#cdb583', floorLo: '#a6925f', accent: '#f77622' },
  { wall: '#5f8478', wains: '#4d6d62', floor: '#71a99c', floorLo: '#5b8a7f', accent: '#2ce8f5' },
]
export function interior(key) { return INTERIORS[(fnv(key) >>> 3) % INTERIORS.length] }

// Neon sign tints for building signage.
const NEONS = ['#2ce8f5', '#ff6e9c', '#feae34', '#63c74d', '#c98bff', '#f6757a']
export function neon(key) { return NEONS[(fnv(key) >>> 6) % NEONS.length] }

// ── People: parts pools ─────────────────────────────────────────────────
export const SKINS = [C.skin1, C.skin2, C.skin3, C.skin4, C.skin5]
export const HAIR_COLORS = ['#2a2336', C.espresso, C.darkBrown, C.brownRed, '#8a4b23', C.amber, '#caa75c', C.cream, C.steel, '#d8d8e8']
export const SHIRTS = [C.red, C.orange, C.amber, C.green, C.blue, C.cyan, C.mauve, C.purple, C.salmon, C.brownOrange, C.grass, C.navy, C.steel, C.hotPink]
export const PANTS = [C.dusk, C.indigo, C.darkBrown, C.slate, C.espresso, C.navy, '#4a3a55']
export const SHOES = [C.espresso, C.ink, C.darkBrown, C.brownRed, C.white, C.navy]
export const JACKETS = ['#3a4466', '#4a3a55', '#264a42', '#5c3a32', '#2f3a5e']

// ── Sky: keyframed day/night driven by local hour ───────────────────────
const SKY = [
  { h: 0,    top: '#0a0e22', bot: '#181c34', amb: 0.08 },
  { h: 4.5,  top: '#0c1228', bot: '#1d2240', amb: 0.10 },
  { h: 6,    top: '#2c3158', bot: '#a04a6a', amb: 0.30 },
  { h: 7,    top: '#4a6a9c', bot: '#e89a62', amb: 0.62 },
  { h: 9,    top: '#5f9ec6', bot: '#a7d4e6', amb: 1.0 },
  { h: 15.5, top: '#549ac4', bot: '#9fcde2', amb: 1.0 },
  { h: 18,   top: '#3d5e92', bot: '#e8743f', amb: 0.5 },
  { h: 19.5, top: '#1d2348', bot: '#5c3a6e', amb: 0.2 },
  { h: 21,   top: '#0c1126', bot: '#1a1f3c', amb: 0.09 },
  { h: 24,   top: '#0a0e22', bot: '#181c34', amb: 0.08 },
]
// The clock hour is quantized to 5s steps: keyframe transitions span hours,
// so a 5s color quantum is far below perceptible, and a stable `sk` object
// between steps lets downstream caches (gradients keyed on sk colors, the
// memoized mix calls) hit instead of churn.
const SKY_Q = 5 / 3600
let _skyHour = -1, _skyVal = null
export function sky(hour) {
  const q = Math.round(hour / SKY_Q) * SKY_Q
  if (q === _skyHour && _skyVal) return _skyVal
  let a = SKY[0], b = SKY[SKY.length - 1]
  for (let i = 0; i < SKY.length - 1; i++) {
    if (q >= SKY[i].h && q <= SKY[i + 1].h) { a = SKY[i]; b = SKY[i + 1]; break }
  }
  const t = b.h === a.h ? 0 : (q - a.h) / (b.h - a.h)
  _skyHour = q
  _skyVal = { top: mix(a.top, b.top, t), bot: mix(a.bot, b.bot, t), amb: a.amb + (b.amb - a.amb) * t }
  return _skyVal
}
