'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const csvPlugin: PreviewPlugin = {
  id: 'csv',
  extensions: ['csv', 'tsv'],
  Component: lazy(() => import('./csv-view').then((m) => ({ default: m.CsvPreview }))),
}
