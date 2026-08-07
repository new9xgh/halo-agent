/**
 * Bounded respawn supervisor for `halo server start -d`.
 *
 * Why it exists: the server exits 1 on any uncaught exception and relies on a
 * supervisor to come back (see dev/deploy.md "Crash semantics"). systemd /
 * Docker deployments have one; a bare `halo server start -d` had none, so a
 * 3am crash meant silent downtime until a human ran `halo server restart`.
 *
 * Deliberately NOT a process manager: no config, no health checks, no log
 * rotation of its own. It re-execs the same `halo` binary as `halo server
 * start` (foreground), watches the exit, and restarts a bounded number of
 * times. Everything the server prints keeps flowing to the daemon log because
 * the child inherits our stdio (fd 1/2 = the log file the `-d` parent opened).
 *
 * Process topology (`halo server start -d`):
 *
 *   user terminal          detached                child of supervisor
 *   ┌───────────────┐      ┌──────────────────┐    ┌──────────────────┐
 *   │ start -d      │─────▶│ supervisor       │───▶│ server           │
 *   │ (exits after  │      │ (server start,   │    │ (server start,   │
 *   │  pidfile poll)│      │  HALO_SUPERVISE) │    │  writes the lock)│
 *   └───────────────┘      └──────────────────┘    └──────────────────┘
 *
 * pid ownership is unchanged: `~/.halo/global/server.lock` is written (and
 * flock'd) by the **server** process itself, so `halo server stop|restart|
 * status` keep targeting the server exactly as before and the single-instance
 * lock keeps arbitrating between servers. The supervisor deliberately has no
 * pidfile — the two things that must not respawn are recognized from the
 * child's exit instead (see `decideRespawn`) plus the stop marker below.
 *
 * Known residual: killing the *supervisor* leaves the server running as an
 * orphan (same end state as the pre-supervisor `-d`). `halo server stop` still
 * stops it, since it targets the server's pid.
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

/** Env marker that turns a `halo server start` re-exec into the supervisor. */
export const SUPERVISE_ENV = 'HALO_SUPERVISE'

/** At most this many restarts inside `RESTART_WINDOW_MS`, then give up. */
export const MAX_RESTARTS = 5
/** Sliding window for the restart budget. */
export const RESTART_WINDOW_MS = 5 * 60_000
/** Fixed pause between restarts — keeps an instant-crash loop off the CPU. */
export const RESTART_DELAY_MS = 2_000

/**
 * Written by `halo server stop` (holding the pid it is about to end), consumed
 * by the supervisor that owned that pid. Two reasons it exists:
 *
 *  - Signals alone can't carry the operator's intent. On Windows
 *    `process.kill(pid, 'SIGTERM')` is a TerminateProcess that surfaces as
 *    plain `code 1, signal null` — indistinguishable from a crash.
 *  - `stop` during backoff: the server is already dead and the supervisor is
 *    sleeping before its next attempt. The marker is the only way to tell it to
 *    stand down instead of bringing the server back.
 *
 * Stamping the pid (rather than a bare flag) is what keeps it unambiguous: a
 * supervisor only honors a marker naming the server *it* just lost, so a
 * `restart`'s new supervisor can't consume the outgoing one's marker, and a
 * leftover marker can't suppress an unrelated respawn.
 */
function stopMarkerPath(): string {
  // Resolved per call, not once at import: `stop` and the supervisor are
  // separate processes that each resolve their own HOME, so there is nothing to
  // cache — and it keeps the path injectable in tests instead of making them
  // write into the developer's real ~/.halo.
  return path.join(homedir(), '.halo', 'global', 'server.stop')
}

export interface ExitInfo {
  code: number | null
  signal: string | null
}

/**
 * Signals that mean a human or a service manager asked for this. Everything
 * else that kills the process — SIGKILL from the OOM killer, SIGSEGV, SIGABRT —
 * is a crash worth restarting, and is exactly the 3am death this supervisor
 * exists for. Same split systemd's `Restart=on-failure` makes.
 *
 * `halo server stop [--force]` doesn't rely on this: it writes the stop marker
 * before signalling, so its SIGTERM *and* its SIGKILL escalation are recognized
 * as intentional on every platform.
 */
const INTENTIONAL_SIGNALS = new Set(['SIGTERM', 'SIGINT'])

export type RespawnDecision =
  | { action: 'stop'; reason: string; giveUp: boolean }
  | { action: 'restart'; attempt: number; delayMs: number; restartTimes: number[] }

/**
 * The whole bounded-restart policy, as a pure function so it can be tested
 * without spawning anything. `restartTimes` are the epoch-ms stamps of prior
 * restarts; a `restart` decision hands back the pruned + appended list.
 */
export function decideRespawn(
  restartTimes: readonly number[],
  exit: ExitInfo,
  now: number,
): RespawnDecision {
  // A shutdown signal means someone asked (a bare `kill <pid>`, Ctrl-C on the
  // daemon, a service manager draining us). Don't fight it.
  if (exit.signal && INTENTIONAL_SIGNALS.has(exit.signal)) {
    return {
      action: 'stop',
      reason: `terminated by ${exit.signal} — not restarting`,
      giveUp: false,
    }
  }
  // Clean exit: `halo server stop`'s SIGTERM path, an upgrade shutdown, etc.
  if (exit.code === 0) {
    return { action: 'stop', reason: 'clean exit — not restarting', giveUp: false }
  }

  const recent = restartTimes.filter((t) => t > now - RESTART_WINDOW_MS)
  if (recent.length >= MAX_RESTARTS) {
    return {
      action: 'stop',
      reason:
        `already restarted ${recent.length}x within ${RESTART_WINDOW_MS / 60_000}min — giving up to avoid a crash loop. ` +
        'Fix the cause (stack above / `halo server logs`), then `halo server start -d`.',
      giveUp: true,
    }
  }
  return {
    action: 'restart',
    attempt: recent.length + 1,
    delayMs: RESTART_DELAY_MS,
    restartTimes: [...recent, now],
  }
}

/** Record that the operator is intentionally ending this server pid. */
export function requestStop(serverPid: number): void {
  try {
    fs.writeFileSync(stopMarkerPath(), String(serverPid))
  } catch { /* no ~/.halo/global/ → no daemon to tell */ }
}

/**
 * Take the pending stop request when it names `serverPid`. Anything else (no
 * marker, or one for a different pid) leaves the file untouched.
 */
export function consumeStopRequest(serverPid: number): boolean {
  const marker = stopMarkerPath()
  try {
    if (parseInt(fs.readFileSync(marker, 'utf-8').trim(), 10) !== serverPid) return false
    fs.rmSync(marker)
    return true
  } catch {
    return false
  }
}

function describeExit(exit: ExitInfo): string {
  return exit.signal ? `server killed by ${exit.signal}` : `server exited code ${exit.code}`
}

/** One line per respawn decision, into the daemon log (our inherited stdout). */
function log(message: string): void {
  process.stdout.write(`[respawn] ${message}\n`)
}

/**
 * Run one server attempt to completion. `pid` is also the server's pid — the
 * foreground `halo server start` imports the server module into the very
 * process we spawn, so it is what lands in `server.lock`.
 */
function runServerOnce(): Promise<ExitInfo & { pid: number | undefined }> {
  const env = { ...process.env }
  delete env[SUPERVISE_ENV] // the child must be a plain server, not another supervisor
  const child = spawn(process.argv[0]!, [process.argv[1]!, 'server', 'start'], {
    stdio: 'inherit',
    env,
  })
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, pid: child.pid }))
    // A failed spawn may never emit 'exit' — resolving here keeps the loop from
    // wedging forever, and a broken re-exec burns the restart budget like any
    // other failure.
    child.once('error', () => resolve({ code: 1, signal: null, pid: child.pid }))
  })
}

export async function superviseServer(): Promise<void> {
  let restartTimes: number[] = []
  for (;;) {
    const { pid, ...exit } = await runServerOnce()
    const stopped = pid !== undefined && consumeStopRequest(pid)

    if (stopped) {
      log(`${describeExit(exit)} after \`halo server stop\` — not restarting`)
      return
    }

    const decision = decideRespawn(restartTimes, exit, Date.now())
    if (decision.action === 'stop') {
      log(`${describeExit(exit)} — ${decision.reason}`)
      if (decision.giveUp) process.exitCode = 1
      return
    }

    restartTimes = decision.restartTimes
    log(`${describeExit(exit)} — restarting (${decision.attempt}/${MAX_RESTARTS}) in ${decision.delayMs / 1000}s`)
    await new Promise((r) => setTimeout(r, decision.delayMs))
    // `stop` may have arrived while we slept: it saw the (already dead) server
    // pid in the lockfile, wrote the marker, and reported "not running".
    if (pid !== undefined && consumeStopRequest(pid)) {
      log('stop requested during backoff — not restarting')
      return
    }
  }
}
