import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveSessionToFile, loadSessionMessages, getSessionDir } from '../src/sessions/session-store.js'
import type { SessionMessage } from '../src/sessions/session-types.js'

/**
 * Contract: session files are written as compact JSON (no 2-space indent). The
 * pretty-print was pure disk overhead — nothing reads these files by eye, and
 * every reader is JSON.parse. What must not change is round-trip fidelity, so
 * this pins "compact on disk" together with "loads back identically", plus the
 * ability to read a pretty-printed file written by an older build.
 */
describe('session file is written compact', () => {
  let projectPath: string

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-compact-json-'))
  })

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  const messages: SessionMessage[] = [
    { id: 'a', type: 'user', role: 'user', content: 'hello', timestamp: 1_700_000_000_000 },
    {
      id: 'b', type: 'assistant', role: 'assistant', content: 'on it', timestamp: 1_700_000_000_001,
      contentBlocks: [
        { type: 'text', text: 'on it', turnId: 't1' },
        { type: 'tool_call', toolCall: { name: 'file_read', input: '/x.ts', output: 'body', toolUseId: 'tu_1' }, turnId: 't1' },
      ],
    },
  ]

  const filePath = () => path.join(getSessionDir('default', projectPath), 'sess-compact.json')

  it('writes no indentation and no newlines', () => {
    saveSessionToFile({
      sessionId: 'sess-compact', projectPath, messages,
      contextTokens: 10, outputTokens: 5, agentId: 'default', agentName: 'Default',
    })

    const raw = fs.readFileSync(filePath(), 'utf-8')
    expect(raw).not.toContain('\n')
    expect(raw.startsWith('{"version":1,')).toBe(true)
  })

  it('round-trips messages through the compact write', () => {
    saveSessionToFile({
      sessionId: 'sess-compact', projectPath, messages,
      contextTokens: 10, outputTokens: 5, agentId: 'default', agentName: 'Default',
    })
    expect(loadSessionMessages('sess-compact', projectPath, 'default')).toEqual(messages)
  })

  it('still loads a pretty-printed file written by an older build', () => {
    // Byte-for-byte the old shape: 2-space indent, and an assistant message
    // carrying BOTH toolCalls and contentBlocks (the pre-dedup writer).
    const dir = getSessionDir('default', projectPath)
    fs.mkdirSync(dir, { recursive: true })
    const legacy = {
      version: 1, id: 'sess-legacy', agentId: 'default', agentName: 'Default',
      title: 'legacy session', source: 'explorer',
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
      messageCount: 2, contextTokens: 7, totalOutputTokens: 3,
      messages: [
        { id: 'a', type: 'user', role: 'user', content: 'old question', timestamp: 1 },
        {
          id: 'b', type: 'assistant', role: 'assistant', content: 'old answer', timestamp: 2,
          toolCalls: [{ name: 'file_read', input: '/legacy.ts', output: 'legacy body' }],
          contentBlocks: [
            { type: 'text', text: 'old answer' },
            { type: 'tool_call', toolCall: { name: 'file_read', input: '/legacy.ts', output: 'legacy body' } },
          ],
        },
      ],
    }
    fs.writeFileSync(path.join(dir, 'sess-legacy.json'), JSON.stringify(legacy, null, 2), 'utf-8')

    const loaded = loadSessionMessages('sess-legacy', projectPath, 'default')
    expect(loaded).toHaveLength(2)
    // The legacy duplicate is preserved on read — this build never rewrites
    // history, it only stops producing new duplicates.
    expect(loaded[1].toolCalls).toHaveLength(1)
    expect(loaded[1].contentBlocks).toHaveLength(2)
  })

  it('a re-save of a pretty file rewrites it compact, preserving createdAt', () => {
    const dir = getSessionDir('default', projectPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'sess-upgrade.json'),
      JSON.stringify({ version: 1, id: 'sess-upgrade', agentId: 'default', title: 'kept title', createdAt: '2023-05-05T00:00:00.000Z', messages: [] }, null, 2),
      'utf-8',
    )

    saveSessionToFile({
      sessionId: 'sess-upgrade', projectPath, messages,
      contextTokens: 0, outputTokens: 0, agentId: 'default',
    })

    const raw = fs.readFileSync(path.join(dir, 'sess-upgrade.json'), 'utf-8')
    expect(raw).not.toContain('\n')
    const parsed = JSON.parse(raw) as { createdAt: string; title: string }
    expect(parsed.createdAt).toBe('2023-05-05T00:00:00.000Z')
    expect(parsed.title).toBe('kept title')
  })
})
