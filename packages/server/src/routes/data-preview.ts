import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { asyncBufferFromFile, parquetMetadataAsync, parquetSchema, parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { resolveProjectPath, validatePath } from './workspace-path.js'

/**
 * Tabular data previews (Parquet / SQLite) for the admin editor.
 *
 * Both formats are parsed server-side and returned as schema + one page of
 * rows in a shared wire shape — large files never travel to the browser, and
 * the admin renders both with a single table component.
 *
 * SQLite opens are strictly read-only (`readonly` + `fileMustExist`) and
 * closed per request, so previewing a live db (e.g. the workspace's own
 * `.halo/halo.db`) leaves no lingering lock — the owner keeps writing
 * (covered by the no-lingering-lock route test; concurrent read+write is
 * WAL's own readers-don't-block-writers guarantee). SQLite may still
 * (re)create the `-shm`/`-wal` coordination sidecars when reading a
 * WAL-mode db; that is standard WAL behavior and harmless (`immutable=1`
 * would avoid it but breaks reading a db that's being written).
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/** A rendered cell — always a JSON scalar so the admin table stays dumb. */
type Cell = string | number | boolean | null

/** Convert one raw value (sqlite row / hyparquet row) into a JSON-safe cell. */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      // int64 beyond 2^53 would silently lose precision as a JS number.
      return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
        ? Number(value)
        : value.toString()
  }
  if (value instanceof Date) return value.toISOString()
  // Covers Buffer (sqlite BLOB) and Uint8Array (parquet BYTE_ARRAY) — never
  // inline binary into JSON.
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`
  // Nested parquet values (LIST / STRUCT) — stringify for display.
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString()
    if (v instanceof Uint8Array) return `<blob ${v.byteLength} bytes>`
    return v
  })
}

/** Quote a SQL identifier (table names can't be bound as parameters). */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function errText(err: unknown): string {
  if ((err as { code?: string }).code === 'SQLITE_NOTADB') return 'File is not a SQLite database'
  return err instanceof Error ? err.message : String(err)
}

export function createDataPreviewRoutes() {
  const app = new Hono()

  // Same (projectId, path) resolution + traversal guard as files.ts.
  async function resolveDataFile(
    projectId: string | undefined,
    filePath: string | undefined,
  ): Promise<{ absolutePath: string } | { error: string; status: 400 | 403 | 404 }> {
    if (!filePath || !projectId) return { error: 'path and projectId are required', status: 400 }
    const projectPath = await resolveProjectPath(projectId)
    if (!projectPath) return { error: 'Project not found', status: 404 }
    if (!validatePath(filePath, projectPath)) return { error: 'Path traversal not allowed', status: 403 }
    const absolutePath = path.resolve(projectPath, filePath)
    try {
      const stat = await fs.stat(absolutePath)
      if (stat.isDirectory()) return { error: 'Path is a directory', status: 400 }
    } catch {
      return { error: 'File not found', status: 404 }
    }
    return { absolutePath }
  }

  function parsePagination(offsetRaw: string | undefined, limitRaw: string | undefined) {
    const offsetNum = parseInt(offsetRaw ?? '0', 10)
    const limitNum = parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10)
    return {
      offset: Math.max(isNaN(offsetNum) ? 0 : offsetNum, 0),
      limit: Math.min(Math.max(isNaN(limitNum) ? DEFAULT_LIMIT : limitNum, 1), MAX_LIMIT),
    }
  }

  function openSqlite(absolutePath: string): Database.Database {
    const db = new Database(absolutePath, { readonly: true, fileMustExist: true })
    // INTEGER is int64 — default mode rounds through a double and corrupts
    // large values (verified: ...983 reads back as ...000). toCell() folds
    // safe bigints back to numbers for the wire.
    db.defaultSafeIntegers(true)
    return db
  }

  // GET /data-preview/sqlite/tables?path=&projectId= — list tables + row counts
  app.get('/data-preview/sqlite/tables', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)

    let db: Database.Database | null = null
    try {
      db = openSqlite(resolved.absolutePath)
      const names = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as Array<{ name: string }>
      // count(*) per table is a synchronous full-table scan — on a multi-GB
      // db this loop can hold the event loop for seconds. Accepted for now
      // (admin-only, low-frequency, previewed dbs are small); the real fix if
      // it bites: lazy rowCount (fetch per table on selection) or a cheap
      // max(rowid) estimate.
      const tables = names.map(({ name }) => ({
        name,
        rowCount: Number((db!.prepare(`SELECT count(*) AS c FROM ${quoteIdent(name)}`).get() as { c: bigint }).c),
      }))
      return c.json({ tables })
    } catch (err) {
      return c.json({ error: errText(err) }, 400)
    } finally {
      db?.close()
    }
  })

  // GET /data-preview/sqlite/rows?path=&projectId=&table=&offset=&limit= — one page of rows
  app.get('/data-preview/sqlite/rows', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
    const table = c.req.query('table')
    if (!table) return c.json({ error: 'table is required' }, 400)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    let db: Database.Database | null = null
    try {
      db = openSqlite(resolved.absolutePath)
      // Identifiers can't be parameterized — gate on actual membership first.
      const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
      if (!exists) return c.json({ error: `Table not found: ${table}` }, 400)

      const totalRows = Number((db.prepare(`SELECT count(*) AS c FROM ${quoteIdent(table)}`).get() as { c: bigint }).c)
      // count(*) + OFFSET both scan synchronously — deep pages of a huge
      // table block the event loop for the scan duration. Accepted for now
      // (admin-only preview, 100-row pages); the real fix is keyset
      // pagination (WHERE rowid > ?) instead of OFFSET.
      const stmt = db.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`)
      const columns = stmt.columns().map((col) => ({ name: col.name, type: col.type ?? '' }))
      const rows = (stmt.raw().all(limit, offset) as unknown[][]).map((row) => row.map(toCell))
      return c.json({ table, columns, rows, totalRows, offset, limit })
    } catch (err) {
      return c.json({ error: errText(err) }, 400)
    } finally {
      db?.close()
    }
  })

  // GET /data-preview/parquet?path=&projectId=&offset=&limit= — schema + one page of rows
  app.get('/data-preview/parquet', async (c) => {
    const resolved = await resolveDataFile(c.req.query('projectId'), c.req.query('path'))
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status)
    const { offset, limit } = parsePagination(c.req.query('offset'), c.req.query('limit'))

    try {
      // asyncBufferFromFile slices with fs streams — hyparquet then reads only
      // the footer + the row groups covering [rowStart, rowEnd), never the
      // whole file.
      const file = await asyncBufferFromFile(resolved.absolutePath)
      const metadata = await parquetMetadataAsync(file)
      const totalRows = Number(metadata.num_rows)
      const columns = parquetSchema(metadata).children.map(({ element }) => ({
        name: element.name,
        type: element.logical_type?.type ?? element.converted_type ?? element.type ?? (element.num_children ? 'GROUP' : ''),
      }))
      const rowStart = Math.min(offset, totalRows)
      const rowEnd = Math.min(offset + limit, totalRows)
      // utf8:false only affects plain BYTE_ARRAY with no STRING/UTF8 logical
      // type (true binary) — those stay Uint8Array and become blob
      // placeholders instead of mojibake text. Real string columns are
      // unaffected (decoded via their logical type).
      const objects = rowStart < rowEnd
        ? await parquetReadObjects({ file, metadata, compressors, rowStart, rowEnd, utf8: false })
        : []
      const rows = objects.map((row) => columns.map((col) => toCell(row[col.name])))
      return c.json({ columns, rows, totalRows, offset, limit })
    } catch (err) {
      // hyparquet throws readable messages for wrong/corrupt files
      // (e.g. "parquet file invalid (footer != PAR1)").
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  return app
}
