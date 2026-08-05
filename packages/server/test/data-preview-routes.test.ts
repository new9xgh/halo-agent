import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createDataPreviewRoutes } from '../src/routes/data-preview.js'

/**
 * Contract: /data-preview/* parses parquet + sqlite server-side and returns
 * schema + one page of rows as plain JSON — with files.ts-grade workspace
 * path validation, strictly read-only close-per-request sqlite opens (a live
 * WAL db is immediately writable by its owner after a preview — no lingering
 * lock), and 400-with-readable-message for bad input (missing table, corrupt
 * file, wrong format) instead of a 500.
 *
 * fixtures/sample.parquet was generated with python3 + pyarrow (snappy
 * compression), 250 rows exercising int64 beyond 2^53, nulls and binary:
 *   pq.write_table(pa.table({
 *     "id": range 1..250 (int64), "name": f"row-{i}", "score": i*0.5 (f64),
 *     "active": i%2==0, "big": 2**60+i (int64),
 *     "note": None every 10th else f"note {i}",
 *     "payload": b"\x01\x02\x03" every 5th else None (binary),
 *   }), "sample.parquet", compression="snappy")
 */

const FIXTURE_PARQUET = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample.parquet')

describe('data-preview routes', () => {
  let ws: string
  let outside: string
  const app = createDataPreviewRoutes()

  const get = async (route: string, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString()
    const res = await app.request(`${route}?${qs}`)
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  beforeAll(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-data-preview-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-data-preview-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.db'), 'outside the workspace')

    fs.copyFileSync(FIXTURE_PARQUET, path.join(ws, 'sample.parquet'))
    fs.writeFileSync(path.join(ws, 'fake.parquet'), 'not really a parquet file at all')
    fs.writeFileSync(path.join(ws, 'garbage.db'), 'not a sqlite database, just text padding padding')

    // WAL-mode db mirroring a live workspace halo.db: BLOB column, big int64,
    // NULLs, and >100 rows to exercise pagination.
    const db = new Database(path.join(ws, 'app.db'))
    db.pragma('journal_mode = WAL')
    db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, weight REAL, data BLOB, big INTEGER)`)
    db.exec(`CREATE TABLE empty_table (a TEXT, b INTEGER)`)
    const ins = db.prepare('INSERT INTO items (label, weight, data, big) VALUES (?, ?, ?, ?)')
    for (let i = 1; i <= 150; i++) {
      ins.run(
        i % 7 === 0 ? null : `item-${i}`,
        i * 1.5,
        i % 10 === 0 ? Buffer.alloc(32, i) : null,
        2n ** 60n + BigInt(i),
      )
    }
    db.close()
  })

  afterAll(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  // ── sqlite ──

  it('sqlite/tables lists tables with row counts', async () => {
    const { status, body } = await get('/data-preview/sqlite/tables', { path: 'app.db', projectId: ws })
    expect(status).toBe(200)
    expect(body.tables).toEqual([
      { name: 'empty_table', rowCount: 0 },
      { name: 'items', rowCount: 150 },
    ])
  })

  it('sqlite/rows returns first page with schema, blob placeholder, exact big ints, NULLs', async () => {
    const { status, body } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'items' })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(150)
    expect(body.offset).toBe(0)
    expect(body.limit).toBe(100)
    const columns = body.columns as Array<{ name: string; type: string }>
    expect(columns.map((c) => c.name)).toEqual(['id', 'label', 'weight', 'data', 'big'])
    expect(columns[1].type).toBe('TEXT')
    const rows = body.rows as Array<Array<unknown>>
    expect(rows).toHaveLength(100)
    // row 1: id=1, label=item-1, weight=1.5, data=NULL, big=2^60+1 (as string — beyond 2^53)
    expect(rows[0]).toEqual([1, 'item-1', 1.5, null, (2n ** 60n + 1n).toString()])
    // row 7: label is NULL
    expect(rows[6][1]).toBeNull()
    // row 10: BLOB → placeholder, not binary
    expect(rows[9][3]).toBe('<blob 32 bytes>')
  })

  it('sqlite/rows paginates with offset/limit', async () => {
    const { body } = await get('/data-preview/sqlite/rows', {
      path: 'app.db', projectId: ws, table: 'items', offset: '140', limit: '25',
    })
    expect(body.offset).toBe(140)
    expect((body.rows as unknown[]).length).toBe(10) // 150 total → last page has 10
    expect((body.rows as Array<Array<unknown>>)[0][0]).toBe(141)
  })

  it('sqlite/rows on an empty table returns schema and zero rows', async () => {
    const { status, body } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'empty_table' })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(0)
    expect(body.rows).toEqual([])
    expect((body.columns as Array<{ name: string }>).map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('sqlite/rows 400s on a nonexistent table (and on injection-shaped names)', async () => {
    const missing = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'nope' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('Table not found: nope')
    const inject = await get('/data-preview/sqlite/rows', {
      path: 'app.db', projectId: ws, table: 'items"; DROP TABLE items; --',
    })
    expect(inject.status).toBe(400)
    // Pin the rejection path: sqlite_master membership check, not a SQL
    // syntax error from the name reaching a query.
    expect(inject.body.error).toBe('Table not found: items"; DROP TABLE items; --')
  })

  it('sqlite preview leaves no lingering lock — the live writer writes fine right after', async () => {
    // Scope note: by the time get() resolves, the route's finally has already
    // closed its readonly connection — so this pins "preview leaves the db
    // immediately writable" (no lock / WAL-handle residue), NOT concurrent
    // read+write (WAL's readers-don't-block-writers is SQLite's own
    // guarantee, not re-proven here).
    const writer = new Database(path.join(ws, 'app.db'))
    try {
      const { status } = await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws, table: 'items' })
      expect(status).toBe(200)
      writer.prepare('INSERT INTO items (label) VALUES (?)').run('written-after-preview')
      const count = writer.prepare('SELECT count(*) c FROM items').get() as { c: number }
      expect(count.c).toBe(151)
      writer.prepare('DELETE FROM items WHERE label = ?').run('written-after-preview')
    } finally {
      writer.close()
    }
  })

  it('sqlite 400s with a readable error on a non-sqlite file', async () => {
    const { status, body } = await get('/data-preview/sqlite/tables', { path: 'garbage.db', projectId: ws })
    expect(status).toBe(400)
    expect(body.error).toBe('File is not a SQLite database')
  })

  // ── parquet ──

  it('parquet returns schema + first page with exact big ints, nulls, blob placeholder', async () => {
    const { status, body } = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws })
    expect(status).toBe(200)
    expect(body.totalRows).toBe(250)
    expect(body.offset).toBe(0)
    const columns = body.columns as Array<{ name: string; type: string }>
    expect(columns.map((c) => c.name)).toEqual(['id', 'name', 'score', 'active', 'big', 'note', 'payload'])
    expect(columns[1].type).toBe('STRING') // logical type surfaced
    const rows = body.rows as Array<Array<unknown>>
    expect(rows).toHaveLength(100)
    expect(rows[0][0]).toBe(1)
    expect(rows[0][1]).toBe('row-1')
    expect(rows[0][2]).toBe(0.5)
    expect(rows[0][3]).toBe(true) // fixture: active = (0-based index) % 2 == 0
    expect(rows[0][4]).toBe((2n ** 60n).toString()) // int64 > 2^53 → exact string
    expect(rows[0][6]).toBe('<blob 3 bytes>') // binary → placeholder
    expect(rows[10][5]).toBeNull() // note is null every 10th row (i=11 → index 10)
  })

  it('parquet paginates with offset/limit and clamps past-the-end reads', async () => {
    const page = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws, offset: '200', limit: '100' })
    expect(page.body.offset).toBe(200)
    expect((page.body.rows as unknown[]).length).toBe(50)
    expect((page.body.rows as Array<Array<unknown>>)[0][0]).toBe(201)
    const past = await get('/data-preview/parquet', { path: 'sample.parquet', projectId: ws, offset: '9999' })
    expect(past.status).toBe(200)
    expect(past.body.rows).toEqual([])
  })

  it('parquet 400s with a readable error on a non-parquet file', async () => {
    const { status, body } = await get('/data-preview/parquet', { path: 'fake.parquet', projectId: ws })
    expect(status).toBe(400)
    expect(String(body.error)).toMatch(/parquet/i)
  })

  // ── shared guards ──

  it('rejects path traversal out of the workspace on all three endpoints', async () => {
    const escape = `../${path.basename(outside)}/secret.db`
    for (const route of ['/data-preview/sqlite/tables', '/data-preview/sqlite/rows', '/data-preview/parquet']) {
      const { status, body } = await get(route, { path: escape, projectId: ws, table: 'items' })
      expect(status).toBe(403)
      expect(body.error).toBe('Path traversal not allowed')
    }
  })

  it('400s on missing params, 404s on missing project / file', async () => {
    expect((await get('/data-preview/parquet', { projectId: ws })).status).toBe(400)
    expect((await get('/data-preview/parquet', { path: 'sample.parquet' })).status).toBe(400)
    expect((await get('/data-preview/sqlite/rows', { path: 'app.db', projectId: ws })).status).toBe(400) // no table
    expect((await get('/data-preview/parquet', { path: 'sample.parquet', projectId: path.join(ws, 'nope') })).status).toBe(404)
    expect((await get('/data-preview/parquet', { path: 'missing.parquet', projectId: ws })).status).toBe(404)
  })
})
