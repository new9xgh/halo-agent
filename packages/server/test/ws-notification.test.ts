import { describe, it, expect } from 'vitest'
import { sendWsNotification } from '../src/ws/event-processor.js'
import { createEmptyUIState } from '../src/sessions/ui-log-builder.js'
import type { OrchestratorEvent } from '../src/agents/agent-events.js'
import type { WebSocket } from 'ws'

/**
 * Contract: the agent-event → WS-message mapping is the wire protocol shared
 * with the admin frontend (documented in .halo/docs/design/ws.md). A field
 * renamed or a case dropped here fails silently — the UI just stops updating
 * (the class of bug this whole branch started from). This is a CHARACTERIZATION
 * test: it pins the current mapping so an *accidental* drift trips it, while an
 * *intentional* protocol change forces updating both this test and ws.md
 * together. Lower-churn than it looks: the event set is closed and frozen.
 */

/** Minimal WS stand-in that records every send() payload. */
function fakeWs() {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>) },
  }
  return { ws: ws as unknown as WebSocket, sent }
}

function notify(event: OrchestratorEvent, sessionId: string | null = 'sess-1') {
  const { ws, sent } = fakeWs()
  const state = createEmptyUIState()
  state.contextTokens = 1000
  state.outputTokens = 200
  sendWsNotification(event, state, 'turn-1', { ws, sessionId })
  return sent
}

describe('sendWsNotification mapping', () => {
  it('thinking → chat:thinking', () => {
    expect(notify({ type: 'thinking', text: 'hmm', agentName: 'a' })).toEqual([
      { type: 'chat:thinking', text: 'hmm', agentName: 'a', taskId: undefined, turnId: 'turn-1' },
    ])
  })

  it('stream → chat:stream', () => {
    expect(notify({ type: 'stream', text: 'tok', agentName: 'a' })).toEqual([
      { type: 'chat:stream', text: 'tok', agentName: 'a', taskId: undefined, turnId: 'turn-1' },
    ])
  })

  it('tool_call → agent:tool_call (tool/input field names)', () => {
    expect(notify({ type: 'tool_call', toolName: 'shell', toolInput: { cmd: 'ls' }, agentName: 'a' })).toEqual([
      { type: 'agent:tool_call', tool: 'shell', input: { cmd: 'ls' }, agentName: 'a', taskId: undefined, turnId: 'turn-1' },
    ])
  })

  it('tool_result → agent:tool_result (result field name + durationMs)', () => {
    expect(notify({ type: 'tool_result', toolResult: 'done', agentName: 'a', durationMs: 12 })).toEqual([
      { type: 'agent:tool_result', result: 'done', agentName: 'a', taskId: undefined, durationMs: 12 },
    ])
  })

  it('agent_start / agent_done → agent:start / agent:done', () => {
    expect(notify({ type: 'agent_start', text: 'task', agentName: 'sub' })).toEqual([
      { type: 'agent:start', agentName: 'sub', task: 'task', taskId: undefined },
    ])
    expect(notify({ type: 'agent_done', agentName: 'sub' })).toEqual([
      { type: 'agent:done', agentName: 'sub', taskId: undefined },
    ])
  })

  it('followup_start and queued_message both → chat:followup', () => {
    expect(notify({ type: 'followup_start', agentName: 'a' })).toEqual([{ type: 'chat:followup', agentName: 'a' }])
    expect(notify({ type: 'queued_message', agentName: 'a' })).toEqual([{ type: 'chat:followup', agentName: 'a' }])
  })

  it('complete → chat:complete carries the sessionId from context', () => {
    expect(notify({ type: 'complete' }, 'sess-42')).toEqual([{ type: 'chat:complete', sessionId: 'sess-42' }])
  })

  it('root usage (no taskId) → chat:usage with state token counts', () => {
    const sent = notify({ type: 'usage', outputTokens: 200, modelId: 'claude' })
    expect(sent).toEqual([
      {
        type: 'chat:usage',
        contextTokens: 1000,
        outputTokens: 200,
        turnId: 'turn-1',
        modelId: 'claude',
        usage: expect.objectContaining({ outputTokens: 200 }),
      },
    ])
  })

  it('sub-agent usage (taskId set) is suppressed', () => {
    expect(notify({ type: 'usage', taskId: 'sub-1', outputTokens: 5 })).toEqual([])
  })

  it('root user message → chat:user', () => {
    expect(notify({ type: 'user', text: 'hi from channel' })).toEqual([{ type: 'chat:user', text: 'hi from channel' }])
  })

  it('local-echo user message is NOT re-pushed (no double render)', () => {
    expect(notify({ type: 'user', text: 'typed in admin', localEcho: true } as OrchestratorEvent)).toEqual([])
  })

  it('sub-agent user turn (taskId set) is suppressed', () => {
    expect(notify({ type: 'user', text: 'inner', taskId: 'sub-1' })).toEqual([])
  })

  it('error → error', () => {
    expect(notify({ type: 'error', error: 'boom', agentName: 'a' })).toEqual([
      { type: 'error', error: 'boom', agentName: 'a', taskId: undefined },
    ])
  })

  it('root compacted → compact:done + session:compacted', () => {
    expect(notify({ type: 'compacted', totalTokens: 777 })).toEqual([
      { type: 'compact:done' },
      { type: 'session:compacted', contextTokens: 777 },
    ])
  })

  it('auto-compact system preflight co-emits compact:started before chat:system', () => {
    const sent = notify({ type: 'system', text: 'Compacting context (32K tokens)…' })
    expect(sent).toEqual([
      { type: 'compact:started' },
      { type: 'chat:system', text: 'Compacting context (32K tokens)…', taskId: undefined, agentName: 'default' },
    ])
  })
})
