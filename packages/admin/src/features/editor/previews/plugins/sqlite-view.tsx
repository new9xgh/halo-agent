'use client'

import { useEffect, useState } from 'react'
import { Table2 } from 'lucide-react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { useDataFetch } from '../ui/use-data-fetch'
import { DataTable } from '../ui/data-table'
import { api } from '@/shared/api-client'
import { useT } from '@/shared/i18n'

const PAGE_SIZE = 100

export function SqlitePreview(props: PreviewProps) {
  const { name, path, projectId, downloadUrl, onOpenAsText } = props
  const t = useT()
  const [table, setTable] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const tablesFetch = useDataFetch(
    projectId ? (signal) => api.dataPreview.sqliteTables(path, projectId, signal) : null,
    [path, projectId],
  )
  const tables = tablesFetch.data?.tables

  // Auto-select the first table once the list arrives.
  useEffect(() => {
    if (!table && tables?.length) setTable(tables[0].name)
  }, [tables, table])

  const rowsFetch = useDataFetch(
    projectId && table
      ? (signal) => api.dataPreview.sqliteRows(path, projectId, table, offset, PAGE_SIZE, signal)
      : null,
    [path, projectId, table, offset],
  )
  const data = rowsFetch.data

  return (
    <PreviewShell
      name={name}
      downloadUrl={downloadUrl}
      onOpenAsText={onOpenAsText}
      loading={tablesFetch.loading || rowsFetch.loading}
      error={tablesFetch.error || rowsFetch.error}
    >
      <div className="flex h-full">
        <div className="w-44 shrink-0 overflow-y-auto border-r border-[var(--border)] bg-[var(--card)]/40 py-1">
          {tables?.length === 0 && (
            <div className="px-3 py-2 text-[10px] text-[var(--muted-foreground)]">{t('dataPreview.noTables')}</div>
          )}
          {tables?.map((tbl) => (
            <button
              key={tbl.name}
              onClick={() => {
                setTable(tbl.name)
                setOffset(0)
              }}
              className={`flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] ${
                tbl.name === table
                  ? 'bg-[var(--secondary)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]/60'
              }`}
            >
              <Table2 className="h-3 w-3 shrink-0" />
              <span className="truncate">{tbl.name}</span>
              <span className="ml-auto text-[9px] tabular-nums text-[var(--muted-foreground)]">{tbl.rowCount}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {data && (
            <DataTable
              columns={data.columns}
              rows={data.rows}
              offset={data.offset}
              limit={data.limit}
              totalRows={data.totalRows}
              onPage={setOffset}
            />
          )}
        </div>
      </div>
    </PreviewShell>
  )
}
