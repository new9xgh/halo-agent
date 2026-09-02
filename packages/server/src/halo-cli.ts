/**
 * Resolve how server-side children (evo wrapper phases, cron jobs) spawn the
 * `halo` cli. Shared by evolution/evo-wrapper.ts and cron/runner.ts, which
 * used to each carry a copy of this logic.
 *
 * Resolution order:
 *   1. $HALO_CLI — explicit override for dev.
 *   2. `halo` on PATH. On Windows we look for the explicit `halo.cmd`, not
 *      the bare `halo`: the desktop NSIS installer drops `halo.cmd` (cli
 *      launcher) and `Halo.exe` (the GUI) into the same $INSTDIR, both on
 *      PATH. PATHEXT ranks `.EXE` above `.CMD`, so a bare `halo` resolves
 *      to the GUI — which relaunches the app and grabs the global
 *      server.lock instead of running the cli. The `.cmd` suffix forces
 *      PATH to the launcher.
 *   3. Dev fallback: when the server runs from the monorepo (dev checkout),
 *      no installer ever put `halo.cmd` on PATH, so step 2 misses and the
 *      spawn dies with "command not found". Detect the repo-local cli build
 *      (`<repo>/packages/cli/dist/index.js`, a fixed sibling of both
 *      `packages/server/src` and `packages/server/dist`) and run it with the
 *      current node. The packaged desktop layout stages the server under
 *      `resources/server-runtime` and the cli under `resources/cli-runtime`,
 *      so this relative path never resolves there — production always takes
 *      step 2.
 *
 * Returns `{ bin, prefixArgs }`: callers spawn `bin` with
 * `[...prefixArgs, ...theirArgs]`, so the node+script fallback is
 * transparent to them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface HaloCli {
  bin: string
  prefixArgs: string[]
}

function isOnPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return true
  }
  return false
}

export function resolveHaloCli(): HaloCli {
  if (process.env.HALO_CLI) return { bin: process.env.HALO_CLI, prefixArgs: [] }
  const name = process.platform === 'win32' ? 'halo.cmd' : 'halo'
  if (isOnPath(name)) return { bin: name, prefixArgs: [] }
  const repoCli = path.resolve(__dirname, '../../cli/dist/index.js')
  if (fs.existsSync(repoCli)) return { bin: process.execPath, prefixArgs: [repoCli] }
  // Nothing found — return the bare name so the failure message stays the
  // familiar "halo: command not found" instead of a confusing resolver error.
  return { bin: name, prefixArgs: [] }
}
