import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../src/features/chat/chat-store'
import { isMainConversationMessage } from '../src/shared/types'
import type { ChatMessage } from '../src/shared/types'

/**
 * Contract: server-pushed system notifications survive redelivery without
 * duplicating in the chat, while genuinely distinct notifications all render.
 *
 * Background — the asymmetry this closes: `chat:stream` reconciles structurally
 * (text accumulates into the turn's block by turnId) and `agent:tool_call`
 * reconciles explicitly (rows with a known toolUseId are dropped), but the
 * three notification paths (`chat:system`, `chat:queued`, `session:compacted`)
 * all appended unconditionally with a fresh `generateId()`. The server likewise
 * mints a fresh id for the live push and for the persisted messageLog row, so
 * ids can never match across a redelivery — content identity is the only key
 * available to the client.
 */

/** Mirror of chat-handlers' `chat:system` handler (the auto/manual compact
 *  preflight + "Auto-compacted N" notices arrive on this path). */
function pushSystem(text: string, taskId?: string): void {
  useChatStore.getState().addMessage({
    id: `gen_${Math.random()}`,
    role: 'system',
    content: text,
    timestamp: Date.now(),
    taskId,
  })
}

/** Mirror of chat-handlers' `session:compacted` handler. */
function pushCompacted(message = 'Context compacted'): void {
  useChatStore.getState().addMessage({
    id: `gen_${Math.random()}`,
    role: 'system',
    content: message,
    timestamp: Date.now(),
  })
}

/** Mirror of chat-handlers' `chat:queued` handler. */
function pushQueued(message = 'Message queued.'): void {
  useChatStore.getState().addMessage({
    id: `gen_${Math.random()}`,
    role: 'system',
    content: message,
    timestamp: Date.now(),
  })
}

function pushUser(text: string): void {
  useChatStore.getState().addMessage({
    id: `gen_${Math.random()}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  })
}

function pushAssistant(text: string): void {
  useChatStore.getState().addMessage({
    id: `gen_${Math.random()}`,
    role: 'assistant',
    content: text,
    timestamp: Date.now(),
  })
}

/** What the chat panel actually renders (chat-panel filters this way). */
function renderedCount(text: string): number {
  return useChatStore
    .getState()
    .messages.filter(isMainConversationMessage)
    .filter((m) => m.content === text).length
}

/** A persisted notification row as it arrives inside a `state:snapshot`
 *  (server ui-log-builder writes `type: 'notification'` + its own genId). */
function snapshotNotification(text: string): ChatMessage {
  return {
    id: `srv_${Math.random()}`,
    type: 'notification',
    role: 'system',
    content: text,
    timestamp: Date.now(),
    agentName: 'System',
  } as ChatMessage
}

const PREFLIGHT = 'Compacting context (160K tokens)…'
const RESULT = 'Auto-compacted 246 older messages'

beforeEach(() => {
  useChatStore.getState().clear()
})

describe('system notification redelivery dedup', () => {
  it('collapses a notification redelivered three times (the reported bug)', () => {
    pushSystem(PREFLIGHT)
    pushSystem(PREFLIGHT)
    pushSystem(PREFLIGHT)

    expect(renderedCount(PREFLIGHT)).toBe(1)
  })

  it('collapses the full compact notification trio, each redelivered', () => {
    // The observed production shape: preflight ×3, result ×3, "Context
    // compacted" ×2 — interleaved the way three deliveries of one compact land.
    pushSystem(PREFLIGHT)
    pushSystem(RESULT)
    pushCompacted()
    pushSystem(PREFLIGHT)
    pushSystem(RESULT)
    pushCompacted()
    pushSystem(PREFLIGHT)
    pushSystem(RESULT)

    expect(renderedCount(PREFLIGHT)).toBe(1)
    expect(renderedCount(RESULT)).toBe(1)
    expect(renderedCount('Context compacted')).toBe(1)
  })

  it('dedups a live push against the same row already applied from a snapshot', () => {
    // Reattach shape: the snapshot carries the persisted notification row, then
    // the live event for the same notification arrives on the same socket. The
    // server ids differ, so only content identity can match them.
    useChatStore.getState().setMessages([snapshotNotification(PREFLIGHT)])
    pushSystem(PREFLIGHT)

    expect(renderedCount(PREFLIGHT)).toBe(1)
  })

  it('dedups `chat:queued` redelivery', () => {
    pushQueued()
    pushQueued()

    expect(renderedCount('Message queued.')).toBe(1)
  })
})

describe('genuinely distinct notifications are never merged', () => {
  it('keeps two real compactions whose token counts differ', () => {
    // Verified against a 3549-message production log: consecutive real
    // preflights read 161K then 163K, 13s apart.
    pushSystem('Compacting context (161K tokens)…')
    pushSystem('Compacting context (163K tokens)…')

    expect(renderedCount('Compacting context (161K tokens)…')).toBe(1)
    expect(renderedCount('Compacting context (163K tokens)…')).toBe(1)
  })

  it('keeps two identical notifications separated by a user turn', () => {
    // The user triggering /compact twice: identical text, but real conversation
    // sits in between, so both bubbles must survive.
    pushSystem(PREFLIGHT)
    pushUser('/compact')
    pushSystem(PREFLIGHT)

    expect(renderedCount(PREFLIGHT)).toBe(2)
  })

  it('keeps two identical notifications separated by an assistant reply', () => {
    pushSystem(RESULT)
    pushAssistant('done')
    pushSystem(RESULT)

    expect(renderedCount(RESULT)).toBe(2)
  })

  it('keeps a root notification and a sub-agent one with the same text', () => {
    // taskId scopes the notification into a different exchange — a sub-agent
    // compacting at the same size is a different event, not a redelivery.
    pushSystem(PREFLIGHT)
    pushSystem(PREFLIGHT, 'sub_task_1')

    const all = useChatStore.getState().messages.filter((m) => m.content === PREFLIGHT)
    expect(all).toHaveLength(2)
    expect(all.filter((m) => !m.taskId)).toHaveLength(1)
    expect(all.filter((m) => m.taskId === 'sub_task_1')).toHaveLength(1)
  })

  it('leaves distinct adjacent notifications alone', () => {
    pushSystem(PREFLIGHT)
    pushSystem(RESULT)
    pushCompacted()

    expect(useChatStore.getState().messages.filter(isMainConversationMessage)).toHaveLength(3)
  })

  it('does not dedup non-notification messages that repeat', () => {
    // Two identical user sends are two real messages.
    pushUser('ping')
    pushUser('ping')

    expect(renderedCount('ping')).toBe(2)
  })
})
