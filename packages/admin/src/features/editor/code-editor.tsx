'use client'

import { useCallback, useRef, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import './monaco-loader'
import { useScopedEditorStore } from '@/shared/stores/editor-store'
import { useTheme, monacoThemeFor, defineMonacoThemes } from '@/shared/theme'

interface CodeEditorProps {
  path: string
  content: string
  language: string
  onChange?: (value: string) => void
  onSave?: () => void
  onClose?: () => void
}

export function CodeEditor({ path, content, language, onChange, onSave, onClose }: CodeEditorProps) {
  const useEditorStore = useScopedEditorStore()
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const { theme } = useTheme()

  // The editor instance persists across tab switches (models swap via the
  // `path` prop), but Monaco actions register once at mount — route them
  // through refs so Cmd+S / Alt+W always hit the *current* tab's handlers
  // instead of the closures captured on first mount.
  const onSaveRef = useRef(onSave)
  const onCloseRef = useRef(onClose)
  const contentRef = useRef(content)
  useEffect(() => {
    onSaveRef.current = onSave
    onCloseRef.current = onClose
    contentRef.current = content
  }, [onSave, onClose, content])

  // Clear selection tracking when editor unmounts or path changes
  useEffect(() => {
    return () => {
      useEditorStore.getState().setSelectedText(null, null)
    }
  }, [path])

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined && onChange) {
        onChange(value)
      }
    },
    [onChange],
  )

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor

      // With `keepCurrentModel`, a remounting editor can pick up a model kept
      // from a previous mount whose content went stale while no editor was
      // showing it (e.g. the agent rewrote the file and the ws `file:changed`
      // refresh updated the buffer). @monaco-editor/react only syncs `value`
      // on prop *changes*, never at mount — reconcile here. setValue (not
      // executeEdits): the content came from disk, resetting undo is correct.
      const model = editor.getModel()
      if (model && model.getValue() !== contentRef.current) {
        model.setValue(contentRef.current)
      }

      // Track selection changes
      editor.onDidChangeCursorSelection((e) => {
        const selection = editor.getSelection()
        if (!selection || selection.isEmpty()) {
          useEditorStore.getState().setSelectedText(null, null)
          return
        }
        const selectedText = editor.getModel()?.getValueInRange(selection) ?? null
        if (selectedText) {
          useEditorStore.getState().setSelectedText(selectedText, {
            startLine: selection.startLineNumber,
            endLine: selection.endLineNumber,
          })
        }
      })

      // Register Cmd+S / Ctrl+S
      editor.addAction({
        id: 'halo-save',
        label: 'Save File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          onSaveRef.current?.()
        },
      })

      // Register Alt+W → close tab (Cmd+W can't be overridden in browsers)
      editor.addAction({
        id: 'halo-close-tab',
        label: 'Close Tab',
        keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyW],
        run: () => {
          onCloseRef.current?.()
        },
      })
    },
    [],
  )

  return (
    <Editor
      // Multi-model mode: `path` (not `key`) drives file switches, so tab
      // changes swap Monaco models on ONE live editor instead of remounting
      // the whole editor (a remount blanks the pane with the "Loading
      // editor..." fallback for a few frames — visible jank on every
      // markdown-preview → code switch). Model swap also preserves per-file
      // undo history and cursor/scroll position (saveViewState default).
      path={path}
      // Models are shared by path across instances (split panes duplicate
      // the active tab by default) — never dispose on unmount or the other
      // pane's editor would be left holding a disposed model.
      keepCurrentModel
      height="100%"
      language={language}
      value={content}
      onChange={handleChange}
      beforeMount={defineMonacoThemes}
      onMount={handleMount}
      theme={monacoThemeFor(theme)}
      options={{
        fontSize: 13,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        smoothScrolling: true,
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: true },
        automaticLayout: true,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
      }}
      loading={
        <div className="flex h-full items-center justify-center bg-[var(--background)]">
          <span className="text-sm text-[var(--muted-foreground)]">Loading editor...</span>
        </div>
      }
    />
  )
}
