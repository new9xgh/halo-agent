'use client'

import { useState } from 'react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { useDataFetch } from '../ui/use-data-fetch'
import { DataTable } from '../ui/data-table'
import { api } from '@/shared/api-client'

const PAGE_SIZE = 100

export function ParquetPreview(props: PreviewProps) {
  const { name, path, projectId, downloadUrl, onOpenAsText } = props
  const [offset, setOffset] = useState(0)

  const { data, error, loading } = useDataFetch(
    projectId ? (signal) => api.dataPreview.parquet(path, projectId, offset, PAGE_SIZE, signal) : null,
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
          onPage={setOffset}
        />
      )}
    </PreviewShell>
  )
}
