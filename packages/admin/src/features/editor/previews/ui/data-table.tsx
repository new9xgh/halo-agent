'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useT } from '@/shared/i18n'

/**
 * Shared table renderer for server-parsed tabular previews (parquet / sqlite):
 * column headers (name + type), rows, and a prev/next pager showing the
 * current range vs. total. Long cell values are truncated with the full value
 * in the title tooltip.
 */

export type DataCell = string | number | boolean | null

const MAX_CELL_CHARS = 200

function cellText(value: DataCell): string {
  if (value === null) return ''
  return typeof value === 'string' ? value : String(value)
}

export function DataTable({
  columns,
  rows,
  offset,
  limit,
  totalRows,
  onPage,
}: {
  columns: Array<{ name: string; type: string }>
  rows: DataCell[][]
  offset: number
  limit: number
  totalRows: number
  onPage: (nextOffset: number) => void
}) {
  const t = useT()
  const from = totalRows === 0 ? 0 : offset + 1
  const to = offset + rows.length

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--card)] shadow-[inset_0_-1px_0_var(--border)]">
            <tr>
              <th className="px-2 py-1.5 text-right text-[10px] font-medium text-[var(--muted-foreground)]">#</th>
              {columns.map((col) => (
                <th key={col.name} className="whitespace-nowrap px-3 py-1.5 text-left">
                  <span className="text-[10px] font-medium text-[var(--foreground)]">{col.name}</span>
                  {col.type && <span className="ml-1.5 text-[9px] font-normal text-[var(--muted-foreground)]">{col.type}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="odd:bg-[var(--card)]/40 hover:bg-[var(--secondary)]">
                <td className="px-2 py-1 text-right text-[10px] text-[var(--muted-foreground)] tabular-nums">{offset + ri + 1}</td>
                {columns.map((_, ci) => {
                  const text = cellText(row[ci] ?? null)
                  const truncated = text.length > MAX_CELL_CHARS
                  return (
                    <td
                      key={ci}
                      title={truncated ? text : undefined}
                      className={`whitespace-nowrap px-3 py-1 ${row[ci] === null ? 'italic text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'}`}
                    >
                      {row[ci] === null ? 'NULL' : truncated ? `${text.slice(0, MAX_CELL_CHARS)}…` : text}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="flex h-24 items-center justify-center text-xs text-[var(--muted-foreground)]">{t('dataPreview.empty')}</div>
        )}
      </div>
      <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--card)] px-3">
        <span className="text-[10px] tabular-nums text-[var(--muted-foreground)]">
          {t('dataPreview.range', { from, to, total: totalRows })}
        </span>
        <button
          onClick={() => onPage(Math.max(offset - limit, 0))}
          disabled={offset === 0}
          title={t('dataPreview.prev')}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors enabled:hover:bg-[var(--secondary)] enabled:hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onPage(offset + limit)}
          disabled={offset + limit >= totalRows}
          title={t('dataPreview.next')}
          className="rounded p-1 text-[var(--muted-foreground)] transition-colors enabled:hover:bg-[var(--secondary)] enabled:hover:text-[var(--foreground)] disabled:opacity-40"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
