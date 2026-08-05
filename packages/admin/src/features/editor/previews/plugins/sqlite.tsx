'use client'

import { lazy } from 'react'
import type { PreviewPlugin } from '../types'

export const sqlitePlugin: PreviewPlugin = {
  id: 'sqlite',
  extensions: ['db', 'sqlite', 'sqlite3'],
  Component: lazy(() => import('./sqlite-view').then((m) => ({ default: m.SqlitePreview }))),
}
