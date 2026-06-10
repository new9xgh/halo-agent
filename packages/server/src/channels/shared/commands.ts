import fs from 'node:fs'
import path from 'node:path'
import type { SessionManager } from '../../agents/session-manager.js'
import { scanAvailableAgents, GLOBAL_AGENTS_DIR } from '../../agents/agent-loader.js'
import { ensureWorkspaceHalo } from '../../init.js'
import { getDisabledSet } from '../../db/index.js'
import { t, type Lang } from './i18n.js'
import { execSkillCommand, scanSkillDescriptors } from '../../commands/skill-command.js'
import type { CommandDescriptor } from '../../commands/types.js'
import { commandRegistry } from '../../commands/index.js'
import { config } from '../../config.js'
import { enqueueEvoRun } from '../../evolution/enqueue.js'

export interface CommandContext {
  sm: SessionManager
  userId: string
  sessionPrefix: string
  accessLevel: 'full' | 'workspace' | 'readonly'
  channelLabel: string
  activeOverrides: Map<string, string>
  workspacePath: string
  lang: Lang
  /** Structured channel origin — used by skills (e.g. cron) to know "I was
   *  invoked from inside this chat, default targets/recipients accordingly".
   *  Absent for admin / WS / CLI invocations. */
  channel?: ChannelContext
}

export interface ChannelContext {
  /** 'telegram' | 'wechat' | 'web' | future. */
  type: string
  /** Account id (telegram bot account, wechat ilink account). */
  accountId: string
  /** Chat id of the conversation the user is in: telegram chat id, wechat
   *  openId. Absent when the channel doesn't have a per-conversation id
   *  (e.g. SSE web). */
  chatId?: string
}

export interface CommandResult {
  text: string
  switchTo?: string
  workspace?: { path: string }
  /** True when the command kicked the agent (sent a user message under
   *  the hood — currently only `execSkillCommand`). The channel handler
   *  should keep its event stream open and forward agent events until
   *  the next `complete`, otherwise the skill body's response is dropped
   *  and the session ends up busy from the user's POV. */
  startedTurn?: boolean
  /** When `startedTurn` is true, the session id the agent is running on.
   *  Channels use this to subscribe to the right session. */
  sessionId?: string
}

export function findActiveSessionId(
  sm: SessionManager,
  userId: string,
  sessionPrefix: string,
  activeOverrides: Map<string, string>,
  accessLevel?: 'full' | 'workspace' | 'readonly',
): string | null {
  const override = activeOverrides.get(userId)

  // Full-access users can switch to any session (cross-channel). The
  // override might point at a session belonging to a different channel,
  // so we resolve it via direct id lookup rather than the prefix-scoped
  // path below.
  if (override && accessLevel === 'full') {
    if (sm.getSessionById(override)) return override
    activeOverrides.delete(userId)
    return null
  }

  // Channel-scoped path. The override (if any) must live under this
  // channel's prefix to be honored; otherwise fall back to "latest in
  // prefix" which is a single indexed query, not a full-table scan.
  if (override && override.startsWith(sessionPrefix)) {
    if (sm.getSessionById(override)) return override
    activeOverrides.delete(userId)
  }

  const latest = sm.findLatestByPrefix(sessionPrefix)
  if (!latest) {
    activeOverrides.delete(userId)
    return null
  }
  return latest.id
}

export async function execHelp(ctx: CommandContext, extraCommands?: Array<string | { head: string; desc: string }>): Promise<CommandResult> {
  // Single source of truth: builtin descriptors + skill descriptors scoped to
  // the *active session's agent* (mirrors `/api/commands?sessionId=...`).
  // Without this, channels like WeChat / Telegram never see skill commands —
  // the registry only ever holds builtins until someone hits the REST route.
  const builtins = commandRegistry.listDescriptors().filter((d) => {
    if (d.source === 'skill') return false
    // Client-side commands (e.g. `/clear` — the admin UI clears the chat
    // pane locally) have no server handler. Channels other than the
    // admin browser would just route them to dispatchCommand, get a
    // cmd.unknown back, and confuse the user. Hide them from /help.
    if (d.type === 'client') return false
    // /note is the manual evo trigger — available at every level (L0 = manual
    // only, L1 = also auto on pre-compact), so it's gated on access, not level.
    // Readonly channel guests still can't trigger evo.
    if (d.name === 'note') {
      if (ctx.accessLevel === 'readonly') return false
    }
    return true
  })
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  // Use the channel account's *current* accessLevel (ctx.accessLevel),
  // not whatever was persisted on the session row when it was first
  // created. Without this, raising a channel from readonly → workspace
  // in the admin UI wouldn't take effect for `/help` until the next time
  // a real chat message updated the row — confusingly hiding skills the
  // user just gave themselves permission for.
  // Resolve which agent's skills to list. With an active session, use its
  // agent. Without one (e.g. right after a `/ws` switch — the channel
  // restarts with no session yet in the new workspace), fall back to
  // `default` so skill commands still show in /help instead of vanishing
  // until the user sends a first message. Mirrors the cold-start fallback
  // in listAvailableSkillCommands.
  const helpAgentId = (active && ctx.sm.getSessionById(active)?.agentId) || 'default'
  const skills = await ctx.sm.listAvailableSkillCommandsForAgent(helpAgentId, ctx.accessLevel)

  // Two-pass render so descriptions align: first compute each command's
  // "head" (slashName + argHint), then pad to the longest head before
  // appending the description.
  const rows: Array<{ head: string; desc: string }> = [...builtins, ...skills]
    .sort((a, b) => a.slashName.localeCompare(b.slashName))
    .map((d) => {
      const arg = d.argHint ? ` ${d.argHint}` : ''
      const showArg = d.name === 'ws' && ctx.accessLevel !== 'full' ? '' : arg
      // Builtin descriptions live in i18n under `cmd.<name>`; skills keep
      // their SKILL.md description (currently English-only). A few commands
      // have access-level-aware variants (e.g. /ws is read-only without
      // `full`) — fall through to the generic key when no variant exists.
      let desc: string
      if (d.source === 'builtin') {
        const variantKey = ctx.accessLevel !== 'full' ? `cmd.${d.name}.readonly` : ''
        const variant = variantKey ? t(variantKey, ctx.lang) : variantKey
        const generic = t(`cmd.${d.name}`, ctx.lang)
        desc = (variant && variant !== variantKey) ? variant : (generic !== `cmd.${d.name}` ? generic : d.description)
      } else {
        desc = d.description
      }
      return { head: `${d.slashName}${showArg}`, desc }
    })

  // Accept channel-specific extras as either pre-formatted strings (legacy)
  // or {head, desc} pairs (new — joins the alignment grid below).
  for (const extra of extraCommands ?? []) {
    if (typeof extra === 'string') {
      // Best-effort split on " — " (em-dash with spaces) so legacy strings
      // still align. If the separator isn't there, fall back to a no-desc row.
      const idx = extra.indexOf(' — ')
      if (idx >= 0) rows.push({ head: extra.slice(0, idx).trim(), desc: extra.slice(idx + 3).trim() })
      else rows.push({ head: extra.trim(), desc: '' })
    } else {
      rows.push(extra)
    }
  }

  const headWidth = Math.max(...rows.map((r) => r.head.length), 0)
  const items = rows.map((r) => r.desc ? `  ${r.head.padEnd(headWidth)}  ${r.desc}` : `  ${r.head}`)

  return { text: [t('help.title', ctx.lang), ...items].join('\n') }
}

export function execStop(ctx: CommandContext): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('stop.no_session', ctx.lang) }
  if (!ctx.sm.isSessionRunning(active)) return { text: t('stop.already_idle', ctx.lang) }
  ctx.sm.stopSession(active).catch(() => {})
  return { text: t('stop.done', ctx.lang) }
}

export function execInterrupt(ctx: CommandContext): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('interrupt.no_session', ctx.lang) }
  if (!ctx.sm.isSessionRunning(active)) return { text: t('interrupt.already_idle', ctx.lang) }
  // Abort the in-flight turn now (including a command mid-run); the server
  // then folds any messages queued while busy into one follow-up turn. Unlike
  // /stop, this re-runs rather than ending the session.
  ctx.sm.interruptSession(active)
  return { text: t('interrupt.done', ctx.lang) }
}

export function execCompact(ctx: CommandContext, logPrefix: string): CommandResult {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('compact.no_session', ctx.lang) }
  ctx.sm.compactSession(active).catch((err) => {
    console.log(`[${logPrefix}] /compact ${active}: ${String(err)}`)
  })
  return { text: t('compact.started', ctx.lang) }
}

export async function execNew(ctx: CommandContext): Promise<CommandResult> {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  // Internal agents (self-evolution etc.) are delegated to by other agents,
  // never started directly by a channel user — skip them when picking a default.
  const top = all.filter((a) => !a.disabled && !a.internal).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0]
  const agentId = top?.id ?? 'default'
  const agentName = top?.name ?? 'default'
  const newId = `${ctx.sessionPrefix}${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : ctx.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  try {
    await ctx.sm.createSession(agentId, null, ctx.channelLabel, agentName, newId, undefined, accessLevel)
    ctx.activeOverrides.set(ctx.userId, newId)
    return { text: t('new.done', ctx.lang), switchTo: newId }
  } catch (err) {
    return { text: t('new.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

/**
 * Sessions visible to the current channel user.
 *
 * Full-access users (admin / server-side) see every session in the workspace
 * — necessary for support / cross-channel orchestration.
 * Readonly / workspace users only see sessions their own prefix owns —
 * other users on the same channel exist but their titles are not exposed.
 *
 * `execList` and `execSwitch` share this filter so list indices line up with
 * what switch will accept.
 */
/** Hard cap on what `/list` returns from the db. Render layer slices to
 *  20 (see `execList`'s `slice(0, 20)`); the larger fetch is intentional
 *  for cases where the user wants to scroll/page in a future revision. */
const CHANNEL_LIST_LIMIT = 50

function visibleSessions(ctx: CommandContext) {
  // rootOnly: channel /list / /switch is for picking a conversation to
  // resume. Sub-agent sessions are internal — surfacing them lets the user
  // accidentally jump into a sub-agent's history mid-task. Both full-access
  // and prefix-scoped paths skip subs.
  const { sessions } = ctx.sm.listSessions(
    ctx.accessLevel === 'full'
      ? { rootOnly: true, limit: CHANNEL_LIST_LIMIT }
      : { rootOnly: true, prefix: ctx.sessionPrefix, limit: CHANNEL_LIST_LIMIT },
  )
  return sessions
}

export function execList(ctx: CommandContext): CommandResult {
  const sessions = visibleSessions(ctx)
  if (sessions.length === 0) return { text: t('list.empty', ctx.lang) }

  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const lines = [t('list.title', ctx.lang)]
  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US'
  sessions.slice(0, 50).forEach((s, i) => {
    const marker = s.id === active ? '→ ' : '  '
    const ts = new Date(s.createdAt).toLocaleString(locale, { hour12: false })
    const title = ctx.sm.getSessionTitle(s.id)
    const preview = (title || s.description || '').slice(0, 24)
    let tag: string
    if (s.id.startsWith(ctx.sessionPrefix)) tag = ctx.lang === 'zh' ? '[我]' : '[me]'
    else if (s.id.startsWith('tg_')) tag = '[tg]'
    else if (s.id.startsWith('wx_')) tag = '[wx]'
    else if (s.id.startsWith('web_')) tag = '[web]'
    else tag = '[admin]'
    lines.push(`${marker}${i + 1}. ${tag} ${ts} ${preview}`)
  })
  lines.push('')
  lines.push(ctx.accessLevel === 'full'
    ? t('list.switch_full', ctx.lang)
    : t('list.switch_readonly', ctx.lang))
  return { text: lines.join('\n') }
}

export function execSwitch(ctx: CommandContext, arg: string): CommandResult {
  const sessions = visibleSessions(ctx)
  if (sessions.length === 0) return { text: t('switch.empty', ctx.lang) }
  const idx = parseInt(arg || '', 10)
  if (!Number.isInteger(idx) || idx < 1 || idx > sessions.length) {
    return { text: t('switch.usage', ctx.lang, { max: sessions.length }) }
  }
  const target = sessions[idx - 1]
  // Defense-in-depth: visibleSessions already filters non-full users to
  // their prefix, but keep this check in case the filter ever drifts.
  if (ctx.accessLevel !== 'full' && !target.id.startsWith(ctx.sessionPrefix)) {
    return { text: t('switch.readonly', ctx.lang) }
  }
  ctx.activeOverrides.set(ctx.userId, target.id)
  const locale = ctx.lang === 'zh' ? 'zh-CN' : 'en-US'
  const ts = new Date(target.createdAt).toLocaleString(locale, { hour12: false })
  return { text: t('switch.done', ctx.lang, { idx, time: ts, desc: (target.description || '').slice(0, 40) }), switchTo: target.id }
}

export function formatContextInfo(info: Awaited<ReturnType<SessionManager['getSessionContext']>> & {}): string {
  const pct = info.maxContextTokens > 0
    ? ((info.contextTokens / info.maxContextTokens) * 100).toFixed(1)
    : '?'
  const lines: string[] = [
    `**Workspace:** ${info.workspace}`,
    `**Agent:** ${info.agentId}`,
    `**Model:** ${info.modelId}`,
    `**Thinking:** ${info.thinkingEffort}`,
    `**Context:** ~${(info.contextTokens / 1000).toFixed(1)}K / ${(info.maxContextTokens / 1000).toFixed(0)}K (${pct}%)`,
    `**Messages:** ${info.messageCount}`,
  ]
  if (info.meta.toolNames.length > 0) {
    lines.push(`**Tools:** ${info.meta.toolNames.join(', ')}`)
  }
  if (info.meta.skillNames.length > 0) {
    lines.push(`**Skills:** ${info.meta.skillNames.join(', ')}`)
  }
  if (info.meta.mdFiles.length > 0) {
    lines.push('**Markdown:**')
    for (const f of info.meta.mdFiles) {
      lines.push(`  - ${f.label}: ${f.path}`)
    }
  }
  return lines.join('\n')
}

export async function execContext(ctx: CommandContext): Promise<CommandResult> {
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('context.no_session', ctx.lang) }
  const info = await ctx.sm.getSessionContext(active)
  if (!info) return { text: t('context.not_loaded', ctx.lang) }
  return { text: formatContextInfo(info) }
}

/**
 * `/note [hint]` — queue a self-evolution run on the current root session.
 *
 * Synchronous side effects only: snapshot the session log + write a meta.json
 * + insert a `pending` row in `evolution_runs`. The ticker (running in the
 * server process) will pick the row up and spawn the evo wrapper to do the
 * actual LLM work. We return a chat:system reply right away so the user
 * doesn't wait.
 *
 * /note is the manual evo trigger and works at every level (L0 = manual only,
 * L1 = also auto on pre-compact) — so it's not gated on level, only on access.
 *
 * Refused when:
 *   - the user's accessLevel is 'readonly' (channel guests can't trigger evo)
 *   - no active root session in this workspace for the user
 */
export function execNote(ctx: CommandContext, arg: string): CommandResult {
  if (ctx.accessLevel === 'readonly') {
    return { text: t('note.readonly', ctx.lang) }
  }
  const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  if (!active) return { text: t('note.no_session', ctx.lang) }

  // /note only works on root sessions — sub-agent sessions are the parent
  // root's responsibility. Hierarchical ids use `>` to separate parent and
  // child (`root>child>grandchild`); a root id has no `>`.
  if (active.includes('>')) return { text: t('note.no_session', ctx.lang) }

  const result = enqueueEvoRun({
    sm: ctx.sm,
    workspacePath: ctx.workspacePath,
    sourceSessionId: active,
    trigger: 'note',
    userHint: arg.trim() || null,
  })
  if (!result.ok) {
    console.error(`[evo] /note ${result.reason}: ${result.error}`)
    if (result.reason === 'snapshot_failed') return { text: t('note.snapshot_failed', ctx.lang) }
    return { text: t('note.queue_failed', ctx.lang) }
  }
  return { text: t('note.queued', ctx.lang) }
}

/**
 * Names of every slash command this dispatcher actually handles. Imported by
 * `commands/index.ts` to assert that every `type: 'server'` descriptor has a
 * matching case here at server startup — keeping this list and the switch
 * below aligned is otherwise manual and easy to forget.
 *
 * `/help`, `/clear` are absent: those are `type: 'client'` (handled by the
 * channel's frontend or by WS handler before reaching dispatch).
 */
export const DISPATCH_COMMANDS = [
  '/help', '/stop', '/interrupt', '/compact', '/new', '/list', '/switch',
  '/ws', '/context', '/note',
] as const

export async function dispatchCommand(
  ctx: CommandContext,
  command: string,
  arg: string,
  opts?: { channelName?: string; extraHelpLines?: Array<string | { head: string; desc: string }> },
): Promise<CommandResult | null> {
  switch (command) {
    case '/help': return execHelp(ctx, opts?.extraHelpLines)
    case '/stop': return execStop(ctx)
    case '/interrupt': return execInterrupt(ctx)
    case '/compact': return execCompact(ctx, opts?.channelName ?? 'unknown')
    case '/new': return execNew(ctx)
    case '/list': return execList(ctx)
    case '/switch': return execSwitch(ctx, arg)
    case '/ws': return execWs(ctx, arg)
    case '/context': return execContext(ctx)
    case '/note': return execNote(ctx, arg)
    default: {
      // noun-verb routing: for object commands like `/agent`, the first arg
      // token is a verb. Verbs with a builtin handler run as deterministic
      // code (no LLM); everything else falls through to the same-named skill
      // (LLM-driven). Lets `/agent list` be exact while `/agent create` is the
      // skill's job. See SUBCOMMAND_ROUTES.
      const routed = await tryRouteSubcommand(ctx, command, arg)
      if (routed !== NOT_ROUTED) return routed

      const active = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
      if (active) {
        // Pass ctx.accessLevel — the channel account's *current* level —
        // so a recent admin-side change (readonly → workspace, etc.)
        // takes effect immediately. Without this we'd gate against the
        // session row's stale snapshot.
        const result = await execSkillCommand(command, arg, ctx.sm, active, ctx.workspacePath, ctx.channel, ctx.accessLevel, ctx.lang)
        // 'ok' means execSkillCommand kicked sendUserMessage — the agent
        // is now running on `active`. Surface that so the channel keeps
        // its event stream open for the skill body's response.
        if (result === 'ok') return { text: t('skill.activated', ctx.lang, { cmd: command }), startedTurn: true, sessionId: active }
        if (result !== 'not_found') return { text: result }
      }
      return null
    }
  }
}

/** Sentinel: this command/verb has no builtin subcommand handler — caller
 *  should fall through to the skill path. Distinct from a handler returning
 *  `null` (which is a real "handled, no reply" result). */
const NOT_ROUTED = Symbol('not-routed')

/** A builtin subcommand handler. `subArg` is the args after the verb
 *  (e.g. for `/agent switch coder`, verb=`switch`, subArg=`coder`). */
type SubcommandHandler = (ctx: CommandContext, subArg: string) => Promise<CommandResult | null> | CommandResult | null

/** A builtin verb: its handler plus a hardcoded access gate. `requiresAccess`
 *  is code-level (NOT read from the skill's SKILL.md) — builtin verbs are code,
 *  so their permissions live with the code. Unset → open to everyone. */
interface BuiltinVerb {
  handler: SubcommandHandler
  requiresAccess?: 'full' | 'workspace' | 'readonly'
}

/**
 * noun-verb subcommand table. Keyed by object command (`/agent`) → verb
 * (`list`) → { handler, requiresAccess }. A verb NOT in this table falls
 * through to the object's skill (LLM-driven, e.g. `/agent create`, gated by
 * the skill's own requiresAccess in execSkillCommand). Per-verb access is
 * hardcoded here so read-only verbs (list/desc) and destructive ones (delete)
 * can differ under one `/agent` command.
 */
const SUBCOMMAND_ROUTES: Record<string, Record<string, BuiltinVerb>> = {
  '/agent': {
    list: { handler: (ctx) => execAgentList(ctx), requiresAccess: 'workspace' },
    switch: { handler: (ctx, subArg) => execAgentSwitch(ctx, subArg), requiresAccess: 'workspace' },
    desc: { handler: (ctx, subArg) => execAgentDesc(ctx, subArg), requiresAccess: 'workspace' },
    delete: { handler: (ctx, subArg) => execAgentDelete(ctx, subArg), requiresAccess: 'full' },
  },
}

// ── /agent builtin verbs ─────────────────────────────────────────────────────
// Deterministic agent management. create / update are NOT here — they fall
// through to the `agent` skill (LLM-driven, needs to author yaml + AGENT.md).

/** Usable agents: deduped (workspace overrides global), internal + disabled
 *  excluded. Shared by every /agent verb so they see the same set. */
async function loadUsableAgents(ctx: CommandContext) {
  const disabledSet = getDisabledSet(ctx.sm.getDb(), 'agent')
  const all = await scanAvailableAgents(ctx.workspacePath, disabledSet)
  const seen = new Map<string, typeof all[0]>()
  for (const a of all) {
    if (a.disabled || a.internal) continue
    if (!seen.has(a.id) || a.scope === 'workspace') seen.set(a.id, a)
  }
  return [...seen.values()]
}

/** Resolve an agent by 1-based index or by id/name, against the usable set. */
function resolveAgent(agents: Awaited<ReturnType<typeof loadUsableAgents>>, arg: string) {
  const idx = parseInt(arg, 10)
  if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) return agents[idx - 1]
  return agents.find((a) => a.id === arg || a.name === arg)
}

export async function execAgentList(ctx: CommandContext): Promise<CommandResult> {
  const agents = await loadUsableAgents(ctx)
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }
  const activeSessionId = findActiveSessionId(ctx.sm, ctx.userId, ctx.sessionPrefix, ctx.activeOverrides, ctx.accessLevel)
  const currentAgentId = activeSessionId ? ctx.sm.getSessionById(activeSessionId)?.agentId : undefined
  const lines = [t('agents.title', ctx.lang)]
  agents.forEach((a, i) => {
    const scope = a.scope === 'workspace' ? '[ws]' : (ctx.lang === 'zh' ? '[全局]' : '[global]')
    const desc = a.description ? ` — ${a.description.slice(0, 30)}` : ''
    const current = a.id === currentAgentId ? ' ◀' : ''
    lines.push(`  ${i + 1}. ${scope} ${a.id}${desc}${current}`)
  })
  return { text: lines.join('\n') }
}

export async function execAgentSwitch(ctx: CommandContext, arg: string): Promise<CommandResult> {
  if (!arg) return { text: t('agent.usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  if (agents.length === 0) return { text: t('agents.empty', ctx.lang) }
  const agent = resolveAgent(agents, arg)
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }
  const newId = `${ctx.sessionPrefix}${Date.now().toString(36)}`
  const accessLevel = ctx.accessLevel === 'full' ? null : ctx.accessLevel === 'workspace' ? 'workspace' : 'readonly'
  try {
    await ctx.sm.createSession(agent.id, null, ctx.channelLabel, agent.name, newId, undefined, accessLevel)
    ctx.activeOverrides.set(ctx.userId, newId)
    return { text: t('agent.done', ctx.lang, { name: agent.name }), switchTo: newId }
  } catch (err) {
    return { text: t('agent.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

export async function execAgentDesc(ctx: CommandContext, arg: string): Promise<CommandResult> {
  if (!arg) return { text: t('agent.usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  const agent = resolveAgent(agents, arg)
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }
  const lines = [
    `**${agent.name}** (${agent.id}) ${agent.scope === 'workspace' ? '[ws]' : '[global]'}`,
    agent.description ? `\n${agent.description}` : '',
    `\n**Model:** ${agent.model}`,
    agent.tools.length ? `**Tools:** ${agent.tools.join(', ')}` : '',
    agent.skills.length ? `**Skills:** ${agent.skills.join(', ')}` : '',
  ].filter(Boolean)
  return { text: lines.join('\n') }
}

export async function execAgentDelete(ctx: CommandContext, arg: string): Promise<CommandResult> {
  // Access ('full') is gated at the router (SUBCOMMAND_ROUTES) before we get here.
  if (!arg) return { text: t('agent.delete_usage', ctx.lang) }
  const agents = await loadUsableAgents(ctx)
  const agent = resolveAgent(agents, arg)
  if (!agent) return { text: t('agent.not_found', ctx.lang, { name: arg }) }
  // Built-in agents are re-seeded on restart — deleting won't stick.
  const dir = agent.scope === 'workspace'
    ? path.join(ctx.workspacePath, '.halo', 'agents', agent.id)
    : path.join(GLOBAL_AGENTS_DIR, agent.id)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { text: t('agent.delete_done', ctx.lang, { name: agent.name, scope: agent.scope }) }
  } catch (err) {
    return { text: t('agent.failed', ctx.lang, { error: err instanceof Error ? err.message : String(err) }) }
  }
}

/** Route `/<obj> <verb> <rest>`:
 *   - command isn't an object command (no SUBCOMMAND_ROUTES entry) → NOT_ROUTED
 *   - verb empty or `help` → builtin help listing the object's verbs
 *   - verb has a builtin handler → run it (deterministic)
 *   - verb has no handler → NOT_ROUTED (falls through to the skill, e.g. create)
 */
async function tryRouteSubcommand(
  ctx: CommandContext,
  command: string,
  arg: string,
): Promise<CommandResult | null | typeof NOT_ROUTED> {
  const handlers = SUBCOMMAND_ROUTES[command]
  if (!handlers) return NOT_ROUTED

  const descriptors = await scanSkillDescriptors(ctx.workspacePath)
  const desc = descriptors.find((d) => d.slashName === command)

  const trimmed = arg.trim()
  const verb = trimmed.split(/\s+/)[0] ?? ''

  // Bare / help: list only the verbs this user is allowed to run.
  if (verb === '' || verb === 'help') return renderObjectHelp(ctx, command, desc)

  const builtin = handlers[verb]
  // Not a builtin verb → fall through to the skill (e.g. `/agent create`).
  // Its access is gated by the skill's own requiresAccess in execSkillCommand,
  // NOT here — skill-verb permissions live in SKILL.md.
  if (!builtin) return NOT_ROUTED

  // Builtin verb: gate by the verb's hardcoded requiresAccess (code-level,
  // since builtin verbs are code and never reach execSkillCommand). Unset →
  // open to everyone.
  if (builtin.requiresAccess) {
    const RANK = { readonly: 0, workspace: 1, full: 2 } as const
    if (RANK[builtin.requiresAccess] > RANK[ctx.accessLevel]) {
      return { text: t('skill.access_required', ctx.lang, { cmd: `${command} ${verb}`, required: builtin.requiresAccess, current: ctx.accessLevel }) }
    }
  }

  const subArg = trimmed.slice(verb.length).trim()
  return builtin.handler(ctx, subArg)
}

/** Build the `/cmd help` listing from the object command's declared `verbs`
 *  (read from its skill descriptor — the SKILL.md `verbs:` field). Builtin
 *  verbs and skill verbs are listed together so the user sees the full set in
 *  one place, regardless of which side actually handles each. */
async function renderObjectHelp(ctx: CommandContext, command: string, desc?: CommandDescriptor): Promise<CommandResult> {
  // List only verbs the user can actually run. A verb's gate comes from its
  // source: builtin verbs from the hardcoded SUBCOMMAND_ROUTES, skill verbs
  // (create/update) from the skill's object-level requiresAccess. Unset → open.
  const RANK = { readonly: 0, workspace: 1, full: 2 } as const
  const builtins = SUBCOMMAND_ROUTES[command] ?? {}
  const allowed = (verbName: string): boolean => {
    const required = builtins[verbName]?.requiresAccess ?? (verbName in builtins ? undefined : desc?.requiresAccess)
    return !required || RANK[required] <= RANK[ctx.accessLevel]
  }
  const verbs = (desc?.verbs ?? []).filter((v) => allowed(v.name))
  // Verb names + descriptions come from the skill's SKILL.md (English /
  // author-defined), so the listing stays English rather than going through
  // i18n — matches how skill commands render in /help.
  if (verbs.length === 0) {
    return { text: `${command}: no actions to list` }
  }
  const width = Math.max(...verbs.map((v) => v.name.length))
  const lines = verbs.map((v) => `  ${command} ${v.name.padEnd(width)}  ${v.desc ?? ''}`.trimEnd())
  return { text: `${command} actions:\n${lines.join('\n')}` }
}

export function execWs(ctx: CommandContext, arg: string): CommandResult {
  if (!arg) return { text: t('ws.current', ctx.lang, { path: ctx.workspacePath }) }
  if (ctx.accessLevel !== 'full') return { text: t('ws.readonly', ctx.lang) }
  if (!path.isAbsolute(arg)) return { text: t('ws.must_abs', ctx.lang) }
  if (!fs.existsSync(arg)) return { text: t('ws.not_found', ctx.lang, { path: arg }) }
  if (arg === ctx.workspacePath) return { text: t('ws.same', ctx.lang) }
  ensureWorkspaceHalo(arg)
  return { text: t('ws.done', ctx.lang, { path: arg }), workspace: { path: arg } }
}
