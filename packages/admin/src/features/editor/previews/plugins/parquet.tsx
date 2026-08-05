'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const parquetPlugin: PreviewPlugin = {
  id: 'parquet',
  extensions: ['parquet'],
  Component: lazy(() => import('./parquet-view').then((m) => ({ default: m.ParquetPreview }))),
}
