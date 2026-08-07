import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  decideRespawn,
  requestStop,
  consumeStopRequest,
  MAX_RESTARTS,
  RESTART_WINDOW_MS,
  RESTART_DELAY_MS,
} from '../src/server-supervisor.js'

/**
 * Contract for `halo server start -d`'s bounded respawn (audit R1 follow-up).
 * Two invariants carry the whole feature and each has a mutation-checked test
 * below — remove the guard in the source and the named test goes red:
 *
 *   1. BOUNDED. Past MAX_RESTARTS inside RESTART_WINDOW_MS the daemon gives up.
 *      Drop the budget check → 'gives up after MAX_RESTARTS' fails.
 *   2. CLEAN EXIT NEVER RESTARTS. exit 0 (`halo server stop`, upgrade) and the
 *      stop marker must not respawn. Drop either → the 'exit 0' / 'stop marker'
 *      tests fail.
 */

const T0 = 1_700_000_000_000
const crash = { code: 1, signal: null }

describe('decideRespawn — bounded restarts (anti crash-loop)', () => {
  it('restarts a crash (non-zero exit) when the budget allows', () => {
    const d = decideRespawn([], crash, T0)
    expect(d.action).toBe('restart')
    if (d.action !== 'restart') return
    expect(d.attempt).toBe(1)
    expect(d.delayMs).toBe(RESTART_DELAY_MS)
    expect(d.restartTimes).toEqual([T0])
  })

  it('counts up to MAX_RESTARTS, numbering each attempt', () => {
    let times: number[] = []
    for (let i = 1; i <= MAX_RESTARTS; i++) {
      const d = decideRespawn(times, crash, T0 + i * 1000)
      expect(d.action).toBe('restart')
      if (d.action !== 'restart') return
      expect(d.attempt).toBe(i)
      times = d.restartTimes
    }
    expect(times).toHaveLength(MAX_RESTARTS)
  })

  it('gives up after MAX_RESTARTS inside the window (the anti-storm guard)', () => {
    // A config-error insta-crash loop: MAX_RESTARTS deaths one second apart.
    const times = Array.from({ length: MAX_RESTARTS }, (_, i) => T0 + i * 1000)
    const d = decideRespawn(times, crash, T0 + MAX_RESTARTS * 1000)
    expect(d.action).toBe('stop')
    if (d.action !== 'stop') return
    expect(d.giveUp).toBe(true)
    expect(d.reason).toMatch(/crash loop/i)
  })

  it('a seconds-apart crash loop cannot exceed MAX_RESTARTS respawns', () => {
    // Drive the real loop policy rather than a hand-built list: every attempt
    // dies instantly, so nothing ever ages out of the window.
    let times: number[] = []
    let now = T0
    let restarts = 0
    for (let i = 0; i < 100; i++) {
      const d = decideRespawn(times, crash, now)
      if (d.action === 'stop') break
      restarts++
      times = d.restartTimes
      now += RESTART_DELAY_MS + 50 // backoff + an instant crash
    }
    expect(restarts).toBe(MAX_RESTARTS)
  })

  it('prunes restarts older than the window — a long-lived server keeps healing', () => {
    // Used up the budget, but all of it long ago: a fresh crash restarts again.
    const times = Array.from({ length: MAX_RESTARTS }, (_, i) => T0 + i * 1000)
    const later = T0 + RESTART_WINDOW_MS + 60_000
    const d = decideRespawn(times, crash, later)
    expect(d.action).toBe('restart')
    if (d.action !== 'restart') return
    expect(d.attempt).toBe(1)
    expect(d.restartTimes).toEqual([later]) // stale stamps dropped
  })

  it('boundary: a stamp exactly at the window edge is already expired', () => {
    const d = decideRespawn([T0], crash, T0 + RESTART_WINDOW_MS)
    expect(d.action).toBe('restart')
    if (d.action !== 'restart') return
    expect(d.restartTimes).toEqual([T0 + RESTART_WINDOW_MS])
  })
})

describe('decideRespawn — only non-zero exits restart', () => {
  it('exit 0 never restarts (`halo server stop` / upgrade shutdown)', () => {
    const d = decideRespawn([], { code: 0, signal: null }, T0)
    expect(d.action).toBe('stop')
    if (d.action !== 'stop') return
    expect(d.giveUp).toBe(false) // a clean stop is not a failure
  })

  it('exit 0 never restarts even with a fully unused budget', () => {
    expect(decideRespawn([], { code: 0, signal: null }, T0).action).toBe('stop')
    expect(decideRespawn([T0 - 1000], { code: 0, signal: null }, T0).action).toBe('stop')
  })

  it('SIGTERM / SIGINT are intentional shutdowns, not crashes', () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      const d = decideRespawn([], { code: null, signal }, T0)
      expect(d.action).toBe('stop')
      if (d.action !== 'stop') continue
      expect(d.giveUp).toBe(false)
      expect(d.reason).toContain(signal)
    }
  })

  it('SIGKILL / SIGSEGV DO restart — OOM kill and segfault are crashes', () => {
    for (const signal of ['SIGKILL', 'SIGSEGV', 'SIGABRT']) {
      expect(decideRespawn([], { code: null, signal }, T0).action).toBe('restart')
    }
  })

  it('any non-zero code restarts', () => {
    for (const code of [1, 2, 7, 137]) {
      expect(decideRespawn([], { code, signal: null }, T0).action).toBe('restart')
    }
  })
})

describe('stop marker — pid-scoped handshake between `stop` and the supervisor', () => {
  // Redirect HOME to a temp dir: the marker lives next to server.lock in
  // ~/.halo/global, and a developer box may well have a REAL halo server
  // running — writing a marker there could suppress its supervisor's respawn.
  let home = ''
  let markerPath = ''
  const realHome = process.env.HOME

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-stop-marker-'))
    process.env.HOME = home
    markerPath = path.join(home, '.halo', 'global', 'server.stop')
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = realHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('no marker → no stop request (a plain crash is still a crash)', () => {
    expect(consumeStopRequest(4242)) .toBe(false)
  })

  it('marker for this pid is consumed once (a restart then respawns normally)', () => {
    requestStop(4242)
    expect(consumeStopRequest(4242)).toBe(true)
    expect(consumeStopRequest(4242)).toBe(false)
    expect(fs.existsSync(markerPath)).toBe(false)
  })

  it('marker for a DIFFERENT pid is left alone — no cross-supervisor theft', () => {
    // `restart` = stop(old pid) + start: the new supervisor's server must not
    // consume the outgoing server's marker, or its first crash goes unhealed.
    requestStop(4242)
    expect(consumeStopRequest(9999)).toBe(false)
    expect(fs.existsSync(markerPath)).toBe(true) // still there for its owner
    expect(consumeStopRequest(4242)).toBe(true)
  })
})

/**
 * Process-level proof, because the behavior under test IS process lifecycle:
 * run the real superviseServer() loop, spawning real crashing children, and
 * assert it respawns a bounded number of times and logs each one.
 *
 * fixtures/fake-server-cli.ts plays the `halo` binary in both roles (supervisor
 * when run bare, "server" when run as `… server start`) — the same argv shape
 * the supervisor re-execs in production, so no test hook is needed in src/.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = path.resolve(__dirname, '..')
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-server-cli.ts')

function runSupervisor(serverExitCode: number): Promise<string> {
  // Own HOME per run — the supervisor probes ~/.halo/global for a stop marker,
  // and a developer box may have a real halo server whose state we must not read
  // or clear.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-supervise-'))
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', FAKE_CLI],
      {
        cwd: CLI_ROOT,
        timeout: 90_000,
        env: {
          ...process.env,
          HOME: home,
          FAKE_SERVER_EXIT: String(serverExitCode),
          // Inherited by the spawned "server" so the fixture stays TS there too.
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import tsx`.trim(),
        },
      },
      (err, stdout, stderr) => {
        fs.rmSync(home, { recursive: true, force: true })
        if (err && (err as NodeJS.ErrnoException).killed) {
          rejectPromise(new Error(`supervisor timed out (unbounded loop?): ${stdout}\n${stderr}`))
          return
        }
        resolvePromise(stdout)
      },
    )
    child.stdin?.end()
  })
}

describe('superviseServer (real child processes)', () => {
  // RESTART_DELAY_MS between attempts + node startup per attempt.
  const budget = (MAX_RESTARTS + 2) * (RESTART_DELAY_MS + 2_000)

  it(
    'an always-crashing server is respawned MAX_RESTARTS times, then abandoned',
    async () => {
      const stdout = await runSupervisor(1)
      const respawns = stdout.match(/\[respawn\] .*restarting.*/g) ?? []
      expect(respawns).toHaveLength(MAX_RESTARTS)
      // Every line names the attempt and the previous exit code.
      expect(respawns[0]).toMatch(new RegExp(`exited code 1 — restarting \\(1/${MAX_RESTARTS}\\)`))
      expect(respawns[MAX_RESTARTS - 1]).toMatch(new RegExp(`restarting \\(${MAX_RESTARTS}/${MAX_RESTARTS}\\)`))
      expect(stdout).toMatch(/\[respawn\] .*crash loop/i)
      // The server really did run once per attempt (1 initial + MAX_RESTARTS).
      expect(stdout.match(/\[fake-server\] starting/g)).toHaveLength(MAX_RESTARTS + 1)
    },
    budget,
  )

  it(
    'a server that exits 0 is not respawned at all',
    async () => {
      const stdout = await runSupervisor(0)
      expect(stdout).not.toMatch(/— restarting \(/) // the respawn line, not the "not restarting" verdict
      expect(stdout).toMatch(/\[respawn\] server exited code 0 — clean exit/)
      expect(stdout.match(/\[fake-server\] starting/g)).toHaveLength(1)
    },
    budget,
  )
})
