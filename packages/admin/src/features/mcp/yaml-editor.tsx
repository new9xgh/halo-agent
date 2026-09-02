'use client'

import dynamic from 'next/dynamic'
import { useTheme, monacoThemeFor, defineMonacoThemes } from '@/shared/theme'
import '@/features/editor/monaco-loader'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

/**
 * Single-file YAML Monaco editor, modeled on features/agents/md-editor-panel.tsx.
 * CodeEditor (features/editor/code-editor.tsx) is not reused here: it is coupled
 * to the scoped editor store (selection tracking, Cmd+S / Alt+W tab actions,
 * model reconciliation by file path) which only makes sense inside the
 * tabbed file workspace, not a single-config-file form view.
 */
export function YamlEditor({
  value,
  onChange,
  editorKey,
}: {
  value: string
  onChange: (value: string) => void
  /** Remount the editor when this changes (e.g. switching servers). */
  editorKey?: string
}) {
  const { theme } = useTheme()
  return (
    <MonacoEditor
      key={editorKey}
      height="100%"
      language="yaml"
      beforeMount={defineMonacoThemes}
      theme={monacoThemeFor(theme)}
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 8 },
        tabSize: 2,
      }}
    />
  )
}
