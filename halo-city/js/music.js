// Gentle procedural background music — pure Web Audio API, no audio assets,
// no network. A quiet music-box line: single soft sine notes wandering a
// C-major pentatonic scale (small steps, occasional rests), each one struck
// and left to decay naturally — no sustained tones at all, so there is
// nothing to hum or throb. A damped echo gives the notes a little air.
//
// Browsers gate audio behind a user gesture, so the AudioContext is created
// on the first pointerdown / keydown anywhere. The 🎵 HUD button toggles it
// (preference persisted in localStorage, default on); toggling off truly
// suspends the AudioContext — zero CPU while muted.
import { t, onLangChange } from './i18n.js'

const LS_KEY = 'halo_city_music'
const MASTER_VOL = 0.07         // quiet by design
const FADE_S = 1                // toggle fade in/out (no clicks/pops)

// C-major pentatonic, mid register only (C4–E5): no leading-tone tension,
// nothing shrill up top, and no sustained lows — any interval in this set
// sounds consonant, so a random walk can't hit a sour note.
const SCALE = [60, 62, 64, 67, 69, 72, 74, 76]
const NOTE_GAP_MS = [1700, 3200]  // pause between notes (min, max)
const BREATH_MS = [3800, 6000]    // longer rest every few notes
const DECAY_S = 5                 // natural ring-out per note

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12)
const rand = (a, b) => a + Math.random() * (b - a)

let musicOn = loadPref()
let ctx = null                  // created lazily on first gesture
let master = null               // master gain — all fades happen here
let echoSend = null             // note → damped feedback delay (a little air)
let voices = []                 // notes still ringing: { gain, oscs }
let noteTimer = 0
let scaleIdx = 3                // start mid-scale (G4)
let sinceBreath = 0
let btn = null

function loadPref() {
  try { return localStorage.getItem(LS_KEY) !== 'off' } catch { return true }
}

// ── audio graph ──
function ensureCtx() {
  if (ctx) return
  ctx = new (window.AudioContext || window.webkitAudioContext)()

  // master gain → gentle lowpass → out (sines carry no harmonics; the filter
  // just rounds off the echo tails and any note-attack edge)
  master = ctx.createGain()
  master.gain.value = 0
  const lowpass = ctx.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 1800
  lowpass.Q.value = 0.3
  master.connect(lowpass)
  lowpass.connect(ctx.destination)

  // soft echo: damped feedback delay so each note leaves a fading trace
  const delay = ctx.createDelay(2)
  delay.delayTime.value = 0.45
  const damp = ctx.createBiquadFilter()
  damp.type = 'lowpass'
  damp.frequency.value = 1200
  const fb = ctx.createGain()
  fb.gain.value = 0.3
  delay.connect(damp)
  damp.connect(fb)
  fb.connect(delay)
  damp.connect(master)
  echoSend = ctx.createGain()
  echoSend.gain.value = 0.35
  echoSend.connect(delay)
}

function fadeTo(v) {
  const g = master.gain, now = ctx.currentTime
  g.cancelScheduledValues(now)
  g.setValueAtTime(g.value, now)
  g.linearRampToValueAtTime(v, now + FADE_S)
}

// One struck note: pure sine, soft 30ms attack, long natural decay. Every
// few notes a quiet fifth-below shadow note adds warmth (also decaying —
// nothing in this engine sustains). Envelope times are sample-accurate on
// ctx.currentTime; only "when is the next note" rides setTimeout.
function playNote(midi, level, withShadow) {
  const now = ctx.currentTime
  const oscs = []
  const gains = []
  const strike = (m, vol) => {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = hz(m)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(vol, now + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, now + DECAY_S)
    o.connect(g)
    g.connect(master)
    g.connect(echoSend)
    o.start(now)
    o.stop(now + DECAY_S + 0.1)
    oscs.push(o)
    gains.push(g)
  }
  strike(midi, level)
  if (withShadow) strike(midi - 12 < 48 ? midi - 5 : midi - 12, level * 0.4)

  const voice = { gain: gains[0], oscs }
  voices.push(voice)
  oscs[0].onended = () => {
    for (const g of gains) g.disconnect()
    voices = voices.filter((v) => v !== voice)
  }
}

// Melody: a lazy random walk over the pentatonic scale — mostly small steps,
// soft velocity variation, a longer breath every 5–8 notes.
function scheduleNote(delayMs) {
  noteTimer = setTimeout(() => {
    const step = [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]
    scaleIdx = Math.max(0, Math.min(SCALE.length - 1, scaleIdx + step))
    sinceBreath++
    playNote(SCALE[scaleIdx], rand(0.32, 0.5), Math.random() < 0.3)

    let gap = rand(NOTE_GAP_MS[0], NOTE_GAP_MS[1])
    if (sinceBreath >= 5 + Math.floor(Math.random() * 4)) {
      gap = rand(BREATH_MS[0], BREATH_MS[1])
      sinceBreath = 0
    }
    scheduleNote(gap)
  }, delayMs)
}

// ── transport ──
function start() {
  ensureCtx()
  if (ctx.state === 'suspended') ctx.resume()
  clearTimeout(noteTimer)
  fadeTo(MASTER_VOL)
  playNote(SCALE[scaleIdx], 0.4, false)   // open immediately, then wander
  scheduleNote(rand(NOTE_GAP_MS[0], NOTE_GAP_MS[1]))
}

function stop() {
  if (!ctx) return
  clearTimeout(noteTimer)
  fadeTo(0)
  // after the fade lands: silence ringing notes and suspend — zero CPU off
  setTimeout(() => {
    if (musicOn) return   // re-toggled on during the fade
    for (const v of voices) {
      for (const o of v.oscs) { o.onended = null; try { o.stop() } catch { /* already stopped */ } }
      v.gain.disconnect()
    }
    voices = []
    ctx.suspend()
  }, FADE_S * 1000 + 80)
}

// ── UI ──
function syncBtn() {
  if (!btn) return
  btn.textContent = musicOn ? '🎵' : '🔇'
  btn.title = t(musicOn ? 'musicOn' : 'musicOff')
}

export function toggleMusic() {
  musicOn = !musicOn
  try { localStorage.setItem(LS_KEY, musicOn ? 'on' : 'off') } catch { /* ignore */ }
  if (musicOn) start()   // the click itself is a user gesture — safe to (re)start
  else stop()
  syncBtn()
}

export function initMusic() {
  btn = document.getElementById('btn-music')
  btn.addEventListener('click', toggleMusic)
  syncBtn()
  onLangChange(syncBtn)

  // audio is gated behind a user gesture: arm one-shot listeners; if the
  // preference is off, the toggle button (itself a gesture) starts it later
  const arm = () => {
    window.removeEventListener('pointerdown', arm)
    window.removeEventListener('keydown', arm)
    if (musicOn) start()
  }
  window.addEventListener('pointerdown', arm)
  window.addEventListener('keydown', arm)

  // debug/test handle (same convention as window.__world)
  window.__music = {
    isOn: () => musicOn,
    ctxState: () => (ctx ? ctx.state : null),
    masterGain: () => (master ? master.gain.value : 0),
    voiceCount: () => voices.length,
  }
}
