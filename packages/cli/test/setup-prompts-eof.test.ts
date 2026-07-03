import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Regression pin for the stdin-EOF fix (commit 15fc223): when piped stdin runs
 * out of lines before a prompt is answered, readline emits 'close' without the
 * question callback ever firing. Without the 'close' handler the promise stays
 * pending forever and node exits 0 with no answer — a fake-green in CI.
 * Contract: promptText resolves null on EOF, so callers can abort non-zero.
 *
 * Runs the real prompt in a child process (piped stdio = non-TTY plain mode)
 * because the behavior under test IS process-level stdin lifecycle.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = path.resolve(__dirname, '..')

function runPromptScript(script: string, stdinData: string | null): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', '-e', script],
      { cwd: CLI_ROOT, timeout: 20_000 },
      (err, stdout, stderr) => {
        // execFile passes a non-null err for non-zero exit — that's expected here.
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? ((err as unknown as { code: number }).code)
          : err ? 1 : 0
        if (err && (err as NodeJS.ErrnoException).killed) {
          rejectPromise(new Error(`child timed out (hung on EOF?): ${stderr}`))
          return
        }
        resolvePromise({ code, stdout, stderr })
      },
    )
    if (stdinData !== null) child.stdin?.write(stdinData)
    child.stdin?.end()
  })
}

const PROMPT_SCRIPT = `
  const { promptText } = await import('./src/setup-prompts.ts')
  const ans = await promptText('Question')
  if (ans === null) { console.log('GOT_NULL'); process.exit(2) }
  console.log('GOT:' + ans)
  process.exit(0)
`

describe('promptText stdin EOF contract', () => {
  it('resolves null (not hang, not fake-green) when stdin closes with no answer', async () => {
    const res = await runPromptScript(PROMPT_SCRIPT, null) // immediate EOF
    expect(res.stdout).toContain('GOT_NULL')
    expect(res.code).toBe(2)
    expect(res.stderr).toContain('stdin closed before an answer was received')
  })

  it('resolves the piped answer when a line IS available', async () => {
    const res = await runPromptScript(PROMPT_SCRIPT, 'hello\n')
    expect(res.stdout).toContain('GOT:hello')
    expect(res.code).toBe(0)
  })

  it('empty input with a default returns the default', async () => {
    const script = `
      const { promptText } = await import('./src/setup-prompts.ts')
      const ans = await promptText('Q', 'fallback')
      console.log('GOT:' + ans)
      process.exit(ans === 'fallback' ? 0 : 3)
    `
    const res = await runPromptScript(script, '\n')
    expect(res.stdout).toContain('GOT:fallback')
    expect(res.code).toBe(0)
  })
})
