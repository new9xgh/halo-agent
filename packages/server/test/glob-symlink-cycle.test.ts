import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceTools } from '../src/tools/workspace-tools.js'
import type { ToolDef } from '../src/agents/agent-loop.js'

/**
 * Regression coverage for walkDir (shared by glob + grep) against a directory
 * that points back at an ancestor and would otherwise recurse forever, pinning
 * the CPU on a walk that can't be interrupted ("glob **\/*.md hangs").
 *
 * Two flavours of the same trap:
 *  - Unix symlink cycle: caught by the lstat guard (isSymbolicLink() → true),
 *    so the dir is never recursed into. Runs on Linux/macOS.
 *  - Windows junction cycle: lstat reports isSymbolicLink() === false and
 *    isDirectory() === true, so the lstat guard misses it — the win32-only
 *    readlink probe (isReparsePoint) is what stops the loop. Gated to win32
 *    because a real junction can only be created there.
 *
 * Both assert the same contract: the walk terminates AND the real file outside
 * the cycle is still found. A per-test timeout turns a hang into a failure.
 */

let ws: string

function globTool(): ToolDef {
  const tool = createWorkspaceTools(ws, 'full').find((t) => t.name === 'glob')
  if (!tool) throw new Error('glob tool not found')
  return tool
}

const run = (input: { pattern: string; path?: string }) =>
  Promise.resolve(globTool().callback(input)) as Promise<string>

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'halo-glob-cycle-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

const isWin = process.platform === 'win32'

describe.skipIf(isWin)('glob — Unix symlink cycle does not hang', () => {
  it('terminates and finds the real file when a subdir symlinks back to root', async () => {
    writeFileSync(join(ws, 'real.md'), '# real\n')
    mkdirSync(join(ws, 'sub'))
    // sub/loop -> ws : following it would revisit ws forever.
    symlinkSync(ws, join(ws, 'sub', 'loop'))
    const out = await run({ pattern: '**/*.md' })
    expect(out).toContain('real.md')
    expect(out).not.toContain('loop')
  }, 10000)
})

describe.runIf(isWin)('glob — Windows junction cycle does not hang', () => {
  it('terminates and finds the real file when a subdir junction points back to root', async () => {
    writeFileSync(join(ws, 'real.md'), '# real\n')
    mkdirSync(join(ws, 'sub'))
    // 'junction' type makes a real reparse point on Windows (lstat calls it a
    // plain directory, so only the readlink probe stops the recursion).
    symlinkSync(ws, join(ws, 'sub', 'loop'), 'junction')
    const out = await run({ pattern: '**/*.md' })
    expect(out).toContain('real.md')
    expect(out).not.toContain('loop')
  }, 10000)
})
