import { Hono, type Context } from 'hono'
import { getChannelDb } from '../db/channel-db.js'
import { resolveTokenAuth, TOKEN_AUTH_STATUS, type TokenAuthFailure } from '../middleware/web-token.js'
import { readonlySessionCounts, dropRoReader, discoverWorkspaces } from './halo-city.js'
import type { SessionManagerRegistry } from '../agents/session-manager-registry.js'
import type { SessionInfo } from '../agents/session-manager.js'

/** Prometheus-comment wording per auth failure — this surface's own error shape
 *  (the web/show pair render the same failures as JSON). */
const TEXT_ERROR: Record<TokenAuthFailure, string> = {
  locked_out: 'too many failed attempts',
  missing_token: 'token required',
  invalid_token: 'invalid token',
}

/** Per-workspace session cap — the snapshot is bounded so one runaway workspace
 *  can't make a scrape O(all sessions ever). Deliberately higher than
 *  halo-city.ts's 80 (that one caps what a *human* can watch on screen; a
 *  Prometheus scrape wants near-complete counts). */
const SESSIONS_PER_WS = 500

/** Render one Prometheus metric family: HELP + TYPE header then sample lines. */
function family(name: string, type: 'gauge' | 'counter', help: string, samples: Array<{ labels?: string; value: number }>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
  for (const s of samples) lines.push(`${name}${s.labels ? `{${s.labels}}` : ''} ${s.value}`)
  return lines.join('\n')
}

export function createMetricsRoutes(registry: SessionManagerRegistry) {
  const app = new Hono()

  /** Token auth over the shared core in middleware/web-token.ts, rendered as
   *  Prometheus comment lines (a scraper gets text/plain, never JSON) — the
   *  reason why this surface maps the failure itself instead of reusing the
   *  web/show JSON renderer. */
  function auth(c: Context) {
    const a = resolveTokenAuth(c, getChannelDb())
    if (!a.ok) {
      return { ok: false as const, response: c.text(`# ${TEXT_ERROR[a.reason]}\n`, TOKEN_AUTH_STATUS[a.reason]) }
    }
    // Metrics span all workspaces, so require a globally-scoped token: full, or
    // observer — the read-only global role minted exactly for dashboards/scrapes
    // (a workspace-scoped token shouldn't learn deployment-wide size).
    if (a.account.accessLevel !== 'full' && a.account.accessLevel !== 'observer') {
      return { ok: false as const, response: c.text('# global-scope token (full or observer) required\n', 403) }
    }
    return { ok: true as const }
  }

  // GET /api/metrics — Prometheus text exposition. Aggregates the same runtime
  //   signal halo-city's /show/state already collects (session counts by status,
  //   token usage, uptime), but flattened to scrape-friendly gauges.
  app.get('/metrics', (c) => {
    const a = auth(c)
    if (!a.ok) return a.response

    let running = 0, idle = 0, stopped = 0, total = 0
    let contextTokens = 0, outputTokens = 0
    let workspaces = 0

    // Map path→label; a scrape only needs the paths (labels name buildings in halo-city).
    for (const wsPath of discoverWorkspaces(registry).keys()) {
      try {
        // peek, never getOrCreate — same rule as halo-city.ts: this is a read-only
        // surface, and constructing a SessionManager has write side effects
        // (ensureWorkspaceHalo scaffolds .halo/, reconcileOrphansOnBoot stamps
        // stoppedAt over live sub-session rows). No live runtime in this
        // process → degraded read-only db counts (token gauges stay 0 there:
        // nothing in this process drives those sessions).
        const sm = registry.peek(wsPath)
        workspaces++
        if (!sm) {
          const counts = readonlySessionCounts(wsPath, SESSIONS_PER_WS)
          running += counts.running; idle += counts.idle; stopped += counts.stopped; total += counts.total
          continue
        }
        dropRoReader(wsPath) // live runtime took over — retire the ro connection
        const { sessions } = sm.listSessions({ includeArchived: false, limit: SESSIONS_PER_WS })
        for (const r of sessions as SessionInfo[]) {
          total++
          if (r.status === 'running') running++
          else if (r.status === 'idle') idle++
          else stopped++
        }
        // Token totals come from the in-memory UIState of sessions this process
        // is actively driving — the live signal, not a full disk re-read.
        for (const r of sessions as SessionInfo[]) {
          const live = sm.getCachedUIState(r.id.split('>')[0])
          if (live) { contextTokens += live.contextTokens ?? 0; outputTokens += live.outputTokens ?? 0 }
        }
      } catch { /* one broken workspace must not blank the scrape */ }
    }

    const body = [
      family('halo_uptime_seconds', 'gauge', 'Server process uptime in seconds.', [{ value: Math.floor(process.uptime()) }]),
      family('halo_workspaces', 'gauge', 'Number of workspaces visible to the server.', [{ value: workspaces }]),
      family('halo_sessions', 'gauge', 'Non-archived sessions by status.', [
        { labels: 'status="running"', value: running },
        { labels: 'status="idle"', value: idle },
        { labels: 'status="stopped"', value: stopped },
      ]),
      family('halo_sessions_total', 'gauge', 'Total non-archived sessions across all workspaces.', [{ value: total }]),
      family('halo_context_tokens', 'gauge', 'Sum of context tokens across actively-driven sessions.', [{ value: contextTokens }]),
      family('halo_output_tokens', 'gauge', 'Sum of output tokens across actively-driven sessions.', [{ value: outputTokens }]),
    ].join('\n\n') + '\n'

    return c.text(body, 200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
  })

  return app
}
