'use client'

import { useMemo, useState } from 'react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { usePreviewFetch } from '../ui/use-preview-fetch'
import { WorkerClient } from '../workers/worker-client'
import { DataTable } from '../ui/data-table'
import type { XlsxSheet } from '../workers/xlsx.worker'

// Client-side page size: all rows are already in memory (xlsx is a zip — no
// streaming possible, the worker parses the whole book), so paging is just a
// slice; 500 keeps the DOM small while showing plenty per page.
const PAGE_SIZE = 500

let client: WorkerClient | null = null
function getClient(): WorkerClient {
  if (!client) {
    client = new WorkerClient(
      () => new Worker(new URL('../workers/xlsx.worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return client
}

export function XlsxPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props

  const { data: sheets, error, loading } = usePreviewFetch<XlsxSheet[]>(
    viewUrl,
    (buf, signal) => getClient().call<XlsxSheet[]>(signal, buf),
    [],
  )

  const [activeSheet, setActiveSheet] = useState(0)
  const [offset, setOffset] = useState(0)
  const sheet = sheets?.[activeSheet]

  const columns = useMemo(
    () =>
      sheet
        ? Array.from({ length: sheet.colCount }, (_, i) => ({
            name: sheet.headers[i] || String.fromCharCode(65 + i),
            type: '',
          }))
        : [],
    [sheet],
  )
  // Slice the current page and pad ragged rows to colCount so cells render
  // as blanks (worker rows can be shorter than the widest row).
  const pageRows = useMemo(() => {
    if (!sheet) return []
    return sheet.rows
      .slice(offset, offset + PAGE_SIZE)
      .map((row) =>
        row.length >= sheet.colCount ? row : [...row, ...Array<string>(sheet.colCount - row.length).fill('')],
      )
  }, [sheet, offset])

  const extraToolbar = sheets && sheets.length > 1 ? (
    <div className="flex gap-1">
      {sheets.map((s, i) => (
        <button
          key={s.name}
          onClick={() => {
            setActiveSheet(i)
            setOffset(0)
          }}
          className={`rounded px-2 py-0.5 text-[10px] ${
            i === activeSheet
              ? 'bg-[var(--secondary)] text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]'
          }`}
        >
          {s.name}
        </button>
      ))}
    </div>
  ) : null

  return (
    <PreviewShell
      name={name}
      downloadUrl={downloadUrl}
      onOpenAsText={onOpenAsText}
      extraToolbar={extraToolbar}
      loading={loading}
      error={error}
    >
      {sheet && (
        <DataTable
          columns={columns}
          rows={pageRows}
          offset={offset}
          limit={PAGE_SIZE}
          totalRows={sheet.rows.length}
          onPage={setOffset}
        />
      )}
    </PreviewShell>
  )
}
