'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const xlsxPlugin: PreviewPlugin = {
  id: 'xlsx',
  extensions: ['xlsx', 'xls'],
  Component: lazy(() => import('./xlsx-view').then((m) => ({ default: m.XlsxPreview }))),
}
