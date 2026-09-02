'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { api, type McpServerListItem } from '@/shared/api-client'
import { useProjectStore } from '@/shared/stores/project-store'
import {
  Plug, Plus, Trash2, Globe, FolderOpen, ChevronRight, ChevronDown,
  RefreshCw, ToggleLeft, ToggleRight, Loader2, FlaskConical,
} from 'lucide-react'
import { cn, promptInput, confirmAction } from '@/shared/utils'
import { useT } from '@/shared/i18n'
import { wsClient } from '@/shared/ws-client'
import { onWsReconnect } from '@/shared/ws-reconnect'
import { useMcpBus, bumpMcpBus } from '@/shared/mcp-bus'
import { YamlEditor } from './yaml-editor'

type EditorView = 'form' | 'yaml'

/** Composite key for unique server selection (handles same ID in different scopes) */
function serverKey(s: { id: string; scope: string }): string {
  return `${s.id}:${s.scope}`
}

const MCP_SELECTED_KEY = 'halo_mcp_selectedKey'
const MCP_EXPANDED_KEY = 'halo_mcp_expandedScopes'

function loadExpandedScopes(): Set<string> {
  if (typeof window === 'undefined') return new Set(['global', 'workspace'])
  try {
    const raw = localStorage.getItem(MCP_EXPANDED_KEY)
    if (raw) return new Set(JSON.parse(raw))
  } catch {}
  return new Set(['global', 'workspace'])
}

/** request() throws `API error <status>: <body>` — surface the server's
 *  `{error}` field when present (e.g. 409 duplicate id), else the raw message. */
function apiErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const m = msg.match(/API error \d+: ([\s\S]*)$/)
  if (m) {
    try {
      const body = JSON.parse(m[1]) as { error?: string }
      if (body.error) return body.error
    } catch { /* not json */ }
  }
  return msg
}

export function McpMain() {
  const t = useT()
  const activeProject = useProjectStore((s) => s.activeProject)
  const projectId = activeProject?.path ?? undefined
  const [servers, setServers] = useState<McpServerListItem[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(MCP_SELECTED_KEY) : null,
  )
  const [expandedScopes, setExpandedScopes] = useState<Set<string>>(loadExpandedScopes)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (selectedKey) localStorage.setItem(MCP_SELECTED_KEY, selectedKey)
    else localStorage.removeItem(MCP_SELECTED_KEY)
  }, [selectedKey])

  useEffect(() => {
    localStorage.setItem(MCP_EXPANDED_KEY, JSON.stringify([...expandedScopes]))
  }, [expandedScopes])

  const loadServers = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await api.mcp.list(projectId)
      setServers(res.servers)
      if (!selectedKey && res.servers.length > 0) {
        setSelectedKey(serverKey(res.servers[0]))
      }
    } catch (err) {
      console.error('[McpMain] Load failed:', err)
    } finally {
      setRefreshing(false)
    }
  }, [projectId, selectedKey])

  const busVersion = useMcpBus((s) => s.version)
  useEffect(() => { loadServers() }, [loadServers, busVersion])

  // Watch file:changed for external MCP server creations/deletions. Any
  // add/unlink inside .halo/mcp/* bumps the bus. Global servers
  // (~/.halo/global/mcp/) aren't watched by the workspace watcher; the focus
  // refresh below picks them up.
  useEffect(() => {
    if (!projectId) return
    const unsub = wsClient.on('file:changed', (data) => {
      const msg = data as { path: string; action: string }
      if (msg.action !== 'add' && msg.action !== 'unlink' && msg.action !== 'addDir' && msg.action !== 'unlinkDir') return
      if (!msg.path.startsWith('.halo/mcp/')) return
      bumpMcpBus()
    })
    // Reconnect reconciliation — add/unlink events lost while the socket was
    // down would otherwise leave the list stale. See shared/ws-reconnect.
    const unsubReconnect = onWsReconnect(wsClient, bumpMcpBus)
    return () => { unsub(); unsubReconnect() }
  }, [projectId])

  useEffect(() => {
    const onFocus = () => bumpMcpBus()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  const selected = servers.find((s) => serverKey(s) === selectedKey) ?? null

  function toggleScope(scope: string) {
    setExpandedScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) next.delete(scope)
      else next.add(scope)
      return next
    })
  }

  async function handleCreate(scope: 'global' | 'workspace') {
    if (scope === 'workspace' && !projectId) return
    const id = await promptInput(t('mcp.promptId'))
    if (id === null) return
    if (!id.trim()) {
      alert(t('mcp.idRequired'))
      return
    }
    try {
      // stdio with a placeholder command — empty command would fail validation.
      const res = await api.mcp.create({
        id: id.trim(),
        transport: 'stdio',
        command: 'npx',
        scope,
        projectId: scope === 'workspace' ? projectId : undefined,
      })
      const newServer = res.server
      setServers((prev) => {
        const updated = scope === 'workspace'
          ? prev.map((s) => s.id === newServer.id && s.scope === 'global' ? { ...s, overridden: true } : s)
          : prev
        return [...updated, newServer]
      })
      setExpandedScopes((prev) => new Set(prev).add(scope))
      setSelectedKey(serverKey(newServer))
      bumpMcpBus()
    } catch (err) {
      console.error('[McpMain] Create failed:', err)
      alert(apiErrorMessage(err))
    }
  }

  async function handleDelete(server: McpServerListItem) {
    if (!(await confirmAction(t('mcp.confirmDelete', { id: server.id })))) return
    try {
      await api.mcp.remove(server.id, { scope: server.scope, projectId })
      setServers((prev) => {
        const remaining = prev.filter((s) => serverKey(s) !== serverKey(server))
        // If deleting a workspace server, un-override the global counterpart
        if (server.scope === 'workspace') {
          return remaining.map((s) => s.id === server.id && s.scope === 'global' ? { ...s, overridden: false } : s)
        }
        return remaining
      })
      if (selectedKey === serverKey(server)) setSelectedKey(null)
      bumpMcpBus()
    } catch (err) {
      console.error('[McpMain] Delete failed:', err)
      alert(apiErrorMessage(err))
    }
  }

  // Toggle flips the yaml `enabled` field on disk; trust the returned
  // `enabled` rather than optimistic-flipping (mirrors skills-sidebar).
  async function handleToggle(server: McpServerListItem) {
    try {
      const { enabled } = await api.mcp.toggle(server.id, { scope: server.scope, projectId })
      setServers((prev) => prev.map((s) => serverKey(s) === serverKey(server) ? { ...s, enabled } : s))
      bumpMcpBus()
    } catch (err) {
      console.error('[McpMain] Toggle failed:', err)
      alert(apiErrorMessage(err))
    }
  }

  const globalServers = servers.filter((s) => s.scope === 'global')
  const workspaceServers = servers.filter((s) => s.scope === 'workspace')

  const renderSection = (
    scope: 'global' | 'workspace',
    icon: React.ElementType,
    label: string,
    items: McpServerListItem[],
  ) => {
    const Icon = icon
    const expanded = expandedScopes.has(scope)
    return (
      <div key={scope}>
        {/* Section header */}
        <div className="flex items-center h-8 px-2 hover:bg-[var(--secondary)]/50 transition-colors">
          <button onClick={() => toggleScope(scope)} className="flex items-center gap-1.5 flex-1 min-w-0">
            <ChevronRight className={cn('h-3 w-3 shrink-0 text-[var(--muted-foreground)] transition-transform', expanded && 'rotate-90')} />
            <Icon className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
            <span className="text-[11px] font-medium text-[var(--foreground)] truncate">{label}</span>
            <span className="text-[10px] text-[var(--muted-foreground)] ml-auto">{items.length}</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleCreate(scope) }}
            title={t('mcp.new', { scope })}
            className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--secondary)]"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        {/* Server items */}
        {expanded && items.map((server) => {
          const key = serverKey(server)
          return (
            <div
              key={key}
              className={cn(
                'group flex w-full items-center gap-2 pl-7 pr-2 py-1.5 cursor-pointer transition-colors',
                selectedKey === key ? 'bg-[var(--secondary)]' : 'hover:bg-[var(--secondary)]/50',
                (server.overridden || !server.enabled) && 'opacity-40',
              )}
              onClick={() => setSelectedKey(key)}
            >
              <Plug className="h-3 w-3 shrink-0 text-[var(--muted-foreground)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-[11px] font-medium text-[var(--foreground)] truncate">{server.id}</p>
                  <span className="shrink-0 rounded bg-[var(--secondary)] px-1 py-px text-[9px] text-[var(--muted-foreground)]">{server.transport}</span>
                  {server.toolCount !== undefined && (
                    <span className="shrink-0 text-[9px] text-emerald-500">{t('mcp.tools', { n: server.toolCount })}</span>
                  )}
                </div>
                {(server.overridden || !server.enabled || server.description) && (
                  <p className="text-[10px] text-[var(--muted-foreground)] truncate">
                    {server.overridden ? t('mcp.overridden') : !server.enabled ? t('mcp.disabled') : server.description}
                  </p>
                )}
              </div>
              {/* Enable/disable toggle — flips the yaml `enabled` field, so the
                  server's tools stop being injected into agent sessions. */}
              <button
                onClick={(e) => { e.stopPropagation(); handleToggle(server) }}
                title={server.enabled ? t('mcp.disable') : t('mcp.enable')}
                className={cn(
                  'shrink-0 rounded p-0.5 text-[var(--muted-foreground)] transition-opacity hover:text-[var(--foreground)]',
                  server.enabled ? 'opacity-0 group-hover:opacity-100' : 'opacity-100',
                )}
              >
                {server.enabled ? <ToggleRight className="h-4.5 w-4.5 text-blue-500" /> : <ToggleLeft className="h-4.5 w-4.5" />}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(server) }}
                title={t('mcp.delete')}
                className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <PanelGroup direction="horizontal" autoSaveId="halo-mcp-mgmt" className="h-full">
      <Panel defaultSize={22} minSize={12} maxSize={40}>
        <div className="h-full flex flex-col bg-[var(--background)]">
          <div className="flex h-10 items-center border-b border-[var(--border)] px-3">
            <span className="text-sm font-medium text-[var(--foreground)]">{t('mcp.title')}</span>
            <div className="flex-1" />
            <button
              onClick={() => loadServers()}
              disabled={refreshing}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors disabled:opacity-50"
              title={t('mcp.refresh')}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {renderSection('global', Globe, t('common.global'), globalServers)}
            {projectId && renderSection('workspace', FolderOpen, t('common.workspace'), workspaceServers)}
          </div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-px bg-[var(--border)] hover:w-1 hover:bg-[var(--primary)] transition-colors" />
      <Panel defaultSize={78} minSize={40}>
        {selected ? (
          <McpServerEditor
            key={serverKey(selected)}
            server={selected}
            projectId={projectId}
            onSaved={(updated) => {
              setServers((prev) => prev.map((s) => serverKey(s) === serverKey(selected)
                ? { ...s, description: updated.description, transport: updated.transport }
                : s))
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Plug className="h-10 w-10 text-[var(--muted-foreground)]" />
            <p className="text-sm text-[var(--muted-foreground)]">{t('mcp.selectToEdit')}</p>
          </div>
        )}
      </Panel>
    </PanelGroup>
  )
}

type ProbeResult = { ok: boolean; toolCount?: number; tools?: Array<{ name: string; readOnly: boolean }>; error?: string }

/** Form + YAML editor for one MCP server's yaml file. */
function McpServerEditor({
  server,
  projectId,
  onSaved,
}: {
  server: McpServerListItem
  projectId?: string
  onSaved: (server: McpServerListItem) => void
}) {
  const t = useT()
  const [yamlText, setYamlText] = useState('')
  const [parsedData, setParsedData] = useState<Record<string, unknown>>({})
  // Persist the view per-server so switching servers or reloading returns users
  // to the view they were last in.
  const viewStorageKey = `halo_mcp_view:${serverKey(server)}`
  const [view, setViewRaw] = useState<EditorView>(() => {
    if (typeof window === 'undefined') return 'form'
    return (localStorage.getItem(viewStorageKey) as EditorView) ?? 'form'
  })
  // Bumped whenever we enter the form view — remounts the form subtree so its
  // local drafts (args text, env/headers rows) re-init from the latest yaml.
  const [formEpoch, setFormEpoch] = useState(0)
  const setView = useCallback((v: EditorView) => {
    if (typeof window !== 'undefined') localStorage.setItem(viewStorageKey, v)
    if (v === 'form') setFormEpoch((e) => e + 1)
    setViewRaw(v)
  }, [viewStorageKey])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [toolsExpanded, setToolsExpanded] = useState(false)

  const scopeOpts = { scope: server.scope, projectId: server.scope === 'workspace' ? projectId : undefined }

  // Refs used across the load/save effects; keep onSaved current after commit
  // (read only in the async save flow, never during render).
  const onSavedRef = useRef(onSaved)
  useEffect(() => { onSavedRef.current = onSaved })
  const lastSavedYamlRef = useRef<string | null>(null)

  const loadFromDisk = useCallback(async () => {
    setLoading(true)
    setProbeResult(null)
    setToolsExpanded(false)
    try {
      const res = await api.mcp.getYaml(server.id, scopeOpts)
      setYamlText(res.yaml)
      const { parse } = await import('yaml')
      let parsed: unknown = {}
      try { parsed = parse(res.yaml) } catch {}
      setParsedData((parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {})
      // Establish a baseline so auto-save won't re-write the just-loaded content.
      lastSavedYamlRef.current = res.yaml
    } catch (err) {
      console.error('[McpEditor] Load YAML failed:', err)
      setYamlText('')
      setParsedData({})
      lastSavedYamlRef.current = null
    }
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id, server.scope, projectId])

  useEffect(() => { loadFromDisk() }, [loadFromDisk])

  // Auto-save: PUT the current yaml text, debounced. lastSavedYamlRef guards
  // against re-saving just-loaded or just-saved content (loop prevention,
  // mirrors agent-management-main).
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(async () => {
      if (lastSavedYamlRef.current === yamlText) return
      setSaving(true)
      setSaveError(null)
      try {
        const res = await api.mcp.saveYaml(server.id, yamlText, scopeOpts)
        lastSavedYamlRef.current = yamlText
        onSavedRef.current(res.server)
      } catch (err) {
        console.error('[McpEditor] Auto-save failed:', err)
        setSaveError(t('mcp.saveFailed', { error: apiErrorMessage(err) }))
      } finally {
        setSaving(false)
      }
    }, 500)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yamlText, server.id, server.scope, projectId, loading])

  // Form edits flow through here: patch the parsed object, re-stringify into
  // the single shared yamlText state (Monaco edits yamlText directly).
  function updateData(key: string, value: unknown) {
    setParsedData((prev) => {
      const next = { ...prev, [key]: value }
      void import('yaml').then(({ stringify }) => {
        setYamlText(stringify(next, { lineWidth: 120 }))
      })
      return next
    })
  }

  function handleYamlChange(value: string) {
    setYamlText(value)
    void import('yaml').then(({ parse }) => {
      try {
        const parsed: unknown = parse(value)
        if (parsed && typeof parsed === 'object') setParsedData(parsed as Record<string, unknown>)
      } catch { /* keep last good parse while the user is mid-edit */ }
    })
  }

  async function handleProbe() {
    setProbing(true)
    setProbeResult(null)
    setToolsExpanded(false)
    try {
      const res = await api.mcp.probe(server.id, scopeOpts)
      setProbeResult(res)
    } catch (err) {
      setProbeResult({ ok: false, error: apiErrorMessage(err) })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-10 items-center justify-between border-b border-[var(--border)] bg-[var(--card)] px-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* View switch */}
          <div className="flex shrink-0 items-center rounded bg-[var(--secondary)] p-0.5">
            {(['form', 'yaml'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  view === v
                    ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                )}
              >
                {v === 'form' ? t('mcp.form') : t('mcp.yaml')}
              </button>
            ))}
          </div>
          <span className="truncate text-xs font-medium text-[var(--foreground)]">{server.id}</span>
          <span className="shrink-0 rounded bg-[var(--secondary)] px-1.5 py-0.5 text-[9px] text-[var(--muted-foreground)]">{server.scope}</span>
          {saving && <span className="shrink-0 text-[9px] text-[var(--muted-foreground)]">{t('mcp.saving')}</span>}
          {saveError && <span className="truncate text-[9px] text-red-400" title={saveError}>{saveError}</span>}
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <button
            onClick={handleProbe}
            disabled={probing}
            className="flex items-center gap-1.5 rounded bg-[var(--secondary)] px-2.5 py-1 text-xs font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--secondary)]/80 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
            {probing ? t('mcp.testing') : t('mcp.test')}
          </button>
          {probeResult && (
            probeResult.ok ? (
              <button
                onClick={() => setToolsExpanded((v) => !v)}
                className="flex items-center gap-1 text-xs text-emerald-500 hover:opacity-80"
              >
                {t('mcp.testOk', { n: probeResult.toolCount ?? probeResult.tools?.length ?? 0 })}
                {(probeResult.tools?.length ?? 0) > 0 && (
                  <ChevronDown className={cn('h-3 w-3 transition-transform', toolsExpanded && 'rotate-180')} />
                )}
              </button>
            ) : (
              <span className="max-w-64 truncate text-xs text-red-400" title={probeResult.error}>
                {probeResult.error}
              </span>
            )
          )}
          {/* Tools dropdown */}
          {toolsExpanded && probeResult?.ok && probeResult.tools && probeResult.tools.length > 0 && (
            <div className="absolute right-0 top-full z-10 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
              {probeResult.tools.map((tool) => (
                <div key={tool.name} className="flex items-center gap-2 px-3 py-1 text-[11px] text-[var(--foreground)]">
                  <span className="truncate font-mono">{tool.name}</span>
                  {tool.readOnly && (
                    <span className="ml-auto shrink-0 rounded bg-[var(--secondary)] px-1 py-px text-[9px] text-[var(--muted-foreground)]">{t('mcp.readOnly')}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">{t('mcp.loading')}</div>
        ) : view === 'yaml' ? (
          <YamlEditor
            editorKey={`${server.id}:${server.scope}`}
            value={yamlText}
            onChange={handleYamlChange}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            <McpForm key={formEpoch} data={parsedData} onUpdate={updateData} />
          </div>
        )}
      </div>
    </div>
  )
}

const INPUT_CLS = 'h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)]'
const SELECT_CLS = 'h-7 w-full rounded border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)] outline-none focus:border-[var(--primary)] appearance-none cursor-pointer'
const LABEL_CLS = 'text-[11px] font-medium text-[var(--foreground)]'
const DESC_CLS = 'text-[10px] text-[var(--muted-foreground)]'

/** Form view over the parsed yaml object. Local drafts (args text, env/headers
 *  rows) initialize from `data` on mount; the parent remounts this component
 *  (via formEpoch key) whenever the yaml may have changed under it. */
function McpForm({ data, onUpdate }: { data: Record<string, unknown>; onUpdate: (key: string, value: unknown) => void }) {
  const t = useT()
  const transport = data.transport === 'http' ? 'http' : 'stdio'
  const [argsText, setArgsText] = useState(() =>
    Array.isArray(data.args) ? data.args.map(String).join(' ') : String(data.args ?? ''),
  )

  function handleArgsChange(value: string) {
    setArgsText(value)
    onUpdate('args', value.split(/[,\s]+/).filter(Boolean))
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 px-6 py-5">
      {/* Transport — switching keeps the other transport's fields in the yaml
          (harmless), so nothing is lost by flipping back and forth. */}
      <div>
        <span className={LABEL_CLS}>{t('mcp.transport')}</span>
        <select
          value={transport}
          onChange={(e) => onUpdate('transport', e.target.value)}
          className={cn(SELECT_CLS, 'mt-1')}
        >
          <option value="stdio">stdio</option>
          <option value="http">http</option>
        </select>
      </div>

      {transport === 'stdio' ? (
        <>
          <div>
            <span className={LABEL_CLS}>{t('mcp.command')}</span>
            <input
              value={String(data.command ?? '')}
              onChange={(e) => onUpdate('command', e.target.value)}
              placeholder="npx"
              className={cn(INPUT_CLS, 'mt-1 font-mono')}
            />
          </div>
          <div>
            <span className={LABEL_CLS}>{t('mcp.args')}</span>
            <input
              value={argsText}
              onChange={(e) => handleArgsChange(e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className={cn(INPUT_CLS, 'mt-1 font-mono')}
            />
            <p className={cn(DESC_CLS, 'mt-0.5')}>{t('mcp.argsHint')}</p>
          </div>
          <KeyValueEditor
            label={t('mcp.env')}
            value={(data.env as Record<string, string> | undefined) ?? {}}
            onChange={(v) => onUpdate('env', v)}
          />
        </>
      ) : (
        <>
          <div>
            <span className={LABEL_CLS}>{t('mcp.url')}</span>
            <input
              value={String(data.url ?? '')}
              onChange={(e) => onUpdate('url', e.target.value)}
              placeholder="https://example.com/mcp"
              className={cn(INPUT_CLS, 'mt-1 font-mono')}
            />
          </div>
          <KeyValueEditor
            label={t('mcp.headers')}
            value={(data.headers as Record<string, string> | undefined) ?? {}}
            onChange={(v) => onUpdate('headers', v)}
          />
        </>
      )}

      <div>
        <span className={LABEL_CLS}>{t('mcp.description')}</span>
        <input
          value={String(data.description ?? '')}
          onChange={(e) => onUpdate('description', e.target.value)}
          className={cn(INPUT_CLS, 'mt-1')}
        />
      </div>
    </div>
  )
}

/** env / headers key-value list editor. Rows are local drafts (so an empty
 *  new row survives); only non-empty keys propagate up into the yaml object. */
function KeyValueEditor({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}) {
  const t = useT()
  const [rows, setRows] = useState<Array<{ k: string; v: string }>>(() =>
    Object.entries(value).map(([k, v]) => ({ k, v: String(v) })),
  )

  function commit(next: Array<{ k: string; v: string }>) {
    setRows(next)
    const obj: Record<string, string> = {}
    for (const row of next) {
      const key = row.k.trim()
      if (key) obj[key] = row.v
    }
    onChange(obj)
  }

  return (
    <div>
      <span className={LABEL_CLS}>{label}</span>
      <div className="mt-1 space-y-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={row.k}
              onChange={(e) => commit(rows.map((r, j) => j === i ? { ...r, k: e.target.value } : r))}
              placeholder={t('mcp.keyPlaceholder')}
              className={cn(INPUT_CLS, 'font-mono')}
            />
            <input
              value={row.v}
              onChange={(e) => commit(rows.map((r, j) => j === i ? { ...r, v: e.target.value } : r))}
              placeholder={t('mcp.valuePlaceholder')}
              className={cn(INPUT_CLS, 'font-mono')}
            />
            <button
              onClick={() => commit(rows.filter((_, j) => j !== i))}
              title={t('mcp.delete')}
              className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:text-red-400 hover:bg-[var(--secondary)]"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        <button
          onClick={() => commit([...rows, { k: '', v: '' }])}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
        >
          <Plus className="h-3 w-3" />
          {t('mcp.addEntry')}
        </button>
      </div>
    </div>
  )
}
