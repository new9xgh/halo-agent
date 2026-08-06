'use client'

import { useState } from 'react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { useDataFetch } from '../ui/use-data-fetch'
import { DataTable } from '../ui/data-table'
import { api } from '@/shared/api-client'

const PAGE_SIZE = 100

/**
 * CSV/TSV preview — server-paginated like parquet: the browser only ever
 * receives one page, so multi-GB files open instantly. totalRows is lazy
 * (lower bound + hasMore) until a page's scan reaches EOF; DataTable renders
 * it as "N+" while more rows exist.
 */
export function CsvPreview(props: PreviewProps) {
  const { name, path, projectId, downloadUrl, onOpenAsText } = props
  const [offset, setOffset] = useState(0)

  const { data, error, loading } = useDataFetch(
    projectId ? (signal) => api.dataPreview.csv(path, projectId, offset, PAGE_SIZE, signal) : null,
    [path, projectId, offset],
  )

  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText} loading={loading} error={error}>
      {data && (
        <DataTable
          columns={data.columns}
          rows={data.rows}
          offset={data.offset}
          limit={data.limit}
          totalRows={data.totalRows}
          hasMore={data.hasMore}
          onPage={setOffset}
        />
      )}
    </PreviewShell>
  )
}
