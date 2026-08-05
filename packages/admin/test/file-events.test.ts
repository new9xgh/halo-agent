import { describe, it, expect } from 'vitest'
import { isSessionLogEvent } from '../src/shared/file-events'

/**
 * Contract: the shared classifier matches exactly the agent's transcript/log
 * churn — the events that made every git subscriber refetch on each agent
 * utterance — and nothing else. The `.git` case is load-bearing: routes/git.ts
 * re-broadcasts `{path:'.git'}` after every write precisely so those
 * subscribers refresh, so it must never be filtered.
 */

describe('isSessionLogEvent', () => {
  it('matches session transcripts and logs', () => {
    expect(isSessionLogEvent({ path: '.halo/sessions/default/sid_abc.json' })).toBe(true)
    expect(isSessionLogEvent({ path: '.halo/sessions/executor/sid_x.json' })).toBe(true)
    expect(isSessionLogEvent({ path: '.halo/logs/server.log' })).toBe(true)
  })

  it('does not match the synthetic .git write signal', () => {
    // notifyGitChanged() in routes/git.ts — the only reason the panel/graph
    // refresh after commit/stage/push at all.
    expect(isSessionLogEvent({ path: '.git' })).toBe(false)
  })

  it('does not match user files, other .halo trees, or lookalike names', () => {
    expect(isSessionLogEvent({ path: 'src/index.ts' })).toBe(false)
    expect(isSessionLogEvent({ path: '.halo/agents/foo/agent.yaml' })).toBe(false)
    expect(isSessionLogEvent({ path: '.halo/skills/cron/SKILL.md' })).toBe(false)
    expect(isSessionLogEvent({ path: '.halo/memory/2026-01-01-topic.md' })).toBe(false)
    // Not a prefix match: a *file* named like the dirs, and a nested workspace's
    // copy (paths are workspace-relative, so only a root-level .halo counts).
    expect(isSessionLogEvent({ path: '.halo/sessions-backup/x.json' })).toBe(false)
    expect(isSessionLogEvent({ path: 'sub/.halo/sessions/default/s.json' })).toBe(false)
  })

  it('tolerates a payload with no usable path', () => {
    expect(isSessionLogEvent({})).toBe(false)
    expect(isSessionLogEvent({ path: undefined })).toBe(false)
  })
})
