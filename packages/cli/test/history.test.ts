import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Contract: TUI history persists as a JSON array at
 * `~/.halo/global/tui-history.json` (JSON, not line-based — entries may
 * contain newlines since multi-line paste). load must survive a missing /
 * corrupt file, append dedupes against the last entry and caps at 100.
 *
 * HISTORY_FILE is resolved from os.homedir() at module load, so we point HOME
 * at a temp dir BEFORE importing the module (dynamic import).
 */

let tmpHome: string
let loadHistory: () => string[]
let appendHistory: (entry: string) => void
let historyFile: string

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-history-home-'))
  process.env.HOME = tmpHome // os.homedir() reads $HOME on POSIX
  const mod = await import('../src/tui/history.js')
  loadHistory = mod.loadHistory
  appendHistory = mod.appendHistory
  historyFile = path.join(tmpHome, '.halo', 'global', 'tui-history.json')
})

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  fs.rmSync(historyFile, { force: true })
})

describe('loadHistory', () => {
  it('returns [] when the file does not exist (first run)', () => {
    expect(loadHistory()).toEqual([])
  })

  it('returns [] for corrupt JSON instead of throwing', () => {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    fs.writeFileSync(historyFile, '{not json')
    expect(loadHistory()).toEqual([])
  })

  it('filters non-string entries out of a tampered array', () => {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    fs.writeFileSync(historyFile, JSON.stringify(['ok', 42, null, 'also ok']))
    expect(loadHistory()).toEqual(['ok', 'also ok'])
  })
})

describe('appendHistory', () => {
  it('persists entries in order across load', () => {
    appendHistory('first')
    appendHistory('second')
    expect(loadHistory()).toEqual(['first', 'second'])
  })

  it('dedupes an immediate repeat (but keeps non-adjacent repeats)', () => {
    appendHistory('a')
    appendHistory('a')
    appendHistory('b')
    appendHistory('a')
    expect(loadHistory()).toEqual(['a', 'b', 'a'])
  })

  it('round-trips entries containing newlines (multi-line paste)', () => {
    const multi = 'line one\nline two\nline three'
    appendHistory(multi)
    expect(loadHistory()).toEqual([multi])
  })

  it('caps at 100 entries, keeping the most recent', () => {
    for (let i = 0; i < 120; i++) appendHistory(`entry-${i}`)
    const arr = loadHistory()
    expect(arr).toHaveLength(100)
    expect(arr[0]).toBe('entry-20')
    expect(arr[99]).toBe('entry-119')
  })
})
