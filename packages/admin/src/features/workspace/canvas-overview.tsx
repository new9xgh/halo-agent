'use client'

import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Circle, Loader2, XCircle, SkipForward, ChevronDown, ChevronRight, FileText, Download } from 'lucide-react'
import { useChatStore } from '@/features/chat/chat-store'
import { useProjectStore } from '@/shared/stores/project-store'
import { api } from '@/shared/api-client'
import { useSessionBus } from '@/shared/session-bus'
import type { ChatMessage, TaskNodeStatus } from '@/shared/types'
import { cn } from '@/shared/utils'
import { useT } from '@/shared/i18n'

/**
 * Canvas 概览 view (WorkBuddy-style): 任务进程 — the current session's latest
 * task plan as a checklist; 产物 — files the session produced, collected from
 * plan task results (filesChanged) and file_write/file_edit tool calls.
 * Clicking an artifact opens it in the canvas preview view (onOpenArtifact);
 * the download button stays as a secondary action.
 */
export function CanvasOverview({ onOpenArtifact }: { onOpenArtifact?: (path: string) => void }) {
  const t = useT()
  const messages = useChatStore((s) => s.messages)
  const sessionId = useChatStore((s) => s.sessionId)
  const projectId = useProjectStore((s) => s.activeProject?.id)
  const projectPath = useProjectStore((s) => s.activeProject?.path)
  const busVersion = useSessionBus((s) => s.version)
  const [logMessages, setLogMessages] = useState<ChatMessage[]>([])

  // The in-memory chat log only holds the recent tail (older turns load on
  // scroll / were never in the subscribe snapshot) — computed from it alone,
  // plans and artifacts from earlier turns vanish after a session switch.
  // The overview therefore pulls the FULL active log itself; refetch on
  // session switch and whenever a turn settles (session bus bump).
  useEffect(() => {
    if (!sessionId || !projectPath) { setLogMessages([]); return }
    let cancelled = false
    api.sessionLogs.get(sessionId, projectPath)
      .then((res) => {
        if (!cancelled) setLogMessages((res as { messages?: ChatMessage[] }).messages ?? [])
      })
      .catch(() => { if (!cancelled) setLogMessages([]) })
    return () => { cancelled = true }
  }, [sessionId, projectPath, busVersion])

  // Full log + live tail (live wins by id — it covers turns after the fetch).
  const allMessages = useMemo(() => {
    if (logMessages.length === 0) return messages
    const liveIds = new Set(messages.map((m) => m.id))
    return [...logMessages.filter((m) => !liveIds.has(m.id)), ...messages]
  }, [logMessages, messages])

  // Latest plan wins — plans revise as the agent works.
  const plan = useMemo(() => {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].plan) return allMessages[i].plan
    }
    return null
  }, [allMessages])

  const artifacts = useMemo(() => {
    const paths: string[] = []
    const seen = new Set<string>()
    // 产物 = files the session WROTE. Tool names vary (file_write / file_edit /
    // MCP tools / doc generators), so instead of an exact allowlist we match
    // write-ish tool names and accept any input field that looks like a file
    // path (has an extension). Read-only tools (file_read etc.) are excluded
    // by the name filter.
    const WRITEISH = /write|edit|create|patch|save|export|generate|render|build|make/i
    const PATH_KEYS = new Set(['path', 'file', 'filePath', 'file_path', 'filename', 'output', 'outputPath', 'output_path', 'target'])
    const add = (v: unknown) => {
      if (typeof v !== 'string') return
      const s = v.trim()
      if (!s || s.length > 200 || !/\.[a-z0-9]{1,8}$/i.test(s)) return
      if (seen.has(s)) return
      seen.add(s)
      paths.push(s)
    }
    const scanValue = (v: unknown) => {
      if (typeof v === 'string') { add(v); return }
      if (Array.isArray(v)) { v.forEach(scanValue); return }
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (PATH_KEYS.has(k)) scanValue(val)
        }
      }
    }
    const addToolInput = (name: string, input: string) => {
      if (!WRITEISH.test(name)) return
      try { scanValue(JSON.parse(input)) } catch { /* non-JSON input — skip */ }
    }
    for (const m of allMessages) {
      if (m.plan) {
        for (const task of m.plan.tasks) {
          for (const f of task.result?.filesChanged ?? []) add(f.path)
        }
      }
      for (const b of m.contentBlocks ?? []) {
        if (b.type === 'tool_call') addToolInput(b.toolCall.name, b.toolCall.input)
      }
      for (const tc of m.toolCalls ?? []) addToolInput(tc.name, tc.input)
    }
    return paths
  }, [allMessages])

  if (!plan && artifacts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--muted-foreground)]">
        <FileText className="h-8 w-8" />
        <span className="text-xs">{t('canvas.empty')}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col py-1">
      <Section title={t('canvas.taskProgress')} count={plan?.tasks.length}>
        {plan ? (
          <div className="flex flex-col gap-0.5 px-2 pb-2">
            {plan.tasks.map((task) => (
              <div key={task.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5">
                <TaskStatusIcon status={task.status} />
                <span className={cn(
                  'min-w-0 flex-1 text-xs leading-relaxed',
                  task.status === 'completed' || task.status === 'skipped'
                    ? 'text-[var(--muted-foreground)]'
                    : 'text-[var(--foreground)]',
                )}>
                  {task.name}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 pb-2 text-[11px] text-[var(--muted-foreground)]">{t('canvas.empty')}</p>
        )}
      </Section>

      <Section title={t('canvas.artifacts')} count={artifacts.length}>
        {artifacts.length > 0 ? (
          <div className="flex flex-col gap-0.5 px-2 pb-2">
            {artifacts.map((p) => (
              <div
                key={p}
                onClick={() => onOpenArtifact?.(p)}
                className="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--secondary)]"
                title={p}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
                  {p.split('/').pop()}
                </span>
                {projectId && (
                  <a
                    href={api.files.downloadUrl(p, projectId)}
                    download={p.split('/').pop()}
                    title={t('ui.download')}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--foreground)] group-hover:opacity-100"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 pb-2 text-[11px] text-[var(--muted-foreground)]">{t('canvas.empty')}</p>
        )}
      </Section>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
        {count != null && <span className="opacity-60">({count})</span>}
      </button>
      {open && children}
    </div>
  )
}

function TaskStatusIcon({ status }: { status: TaskNodeStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
    case 'running':
      return <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
    case 'failed':
      return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
    case 'skipped':
      return <SkipForward className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
    default:
      return <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
  }
}
