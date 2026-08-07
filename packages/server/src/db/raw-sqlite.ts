/**
 * Escape hatch from a drizzle handle to the underlying better-sqlite3
 * connection, for the few queries drizzle's builder can't express:
 * `PRAGMA data_version` (cron reconcile fast path), `NOT IN (subquery)`
 * (cron run pruning), and `json_each` table-valued joins (evolution
 * run↔apply linking).
 *
 * drizzle exposes it as `$client`; older builds only had `.session.client`,
 * hence the fallback. Both are untyped from our side because drizzle's
 * `$client` type is generic over the driver — the cast is the whole point of
 * this file, so it lives here once instead of being re-spelled at each call
 * site (three at last count, each with its own hand-written method shape).
 */
import type Database from 'better-sqlite3'

export function rawSqlite(db: unknown): Database.Database {
  const withClient = db as {
    $client?: Database.Database
    session?: { client?: Database.Database }
  }
  const client = withClient.$client ?? withClient.session?.client
  if (!client) throw new Error('[raw-sqlite] drizzle handle exposes no better-sqlite3 client')
  return client
}
