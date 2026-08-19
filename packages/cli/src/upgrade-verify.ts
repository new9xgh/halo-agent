/**
 * Post-upgrade native-module smoke check for `halo upgrade`.
 *
 * `npm install -g` can exit 0 while leaving a native module broken: npm 12's
 * allowScripts policy blocks install scripts of packages not on the allow
 * list — better-sqlite3's prebuild-install among them — so its binding
 * (build/Release/better_sqlite3.node) never lands, and the failure only
 * surfaces on the next `halo` start as a cryptic "Could not locate the
 * bindings file". These helpers let cmdUpgrade catch that right after the
 * install instead.
 *
 * The probes run in a child process on purpose: the running process is the
 * OLD install and has its modules in the require cache — requiring them here
 * would false-pass regardless of what the new install looks like.
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

/**
 * Native modules to smoke-test after an upgrade, each with the JS expression
 * the child process evaluates (module dir passed as process.argv[1]).
 *
 * better-sqlite3 resolves its addon lazily inside the Database constructor —
 * a bare require() succeeds even when the binding file is missing (verified
 * on v11.10.0 and v13.0.3) — so its smoke opens a real in-memory db.
 * node-pty loads pty.node eagerly at require time (exports.native), and its
 * prebuilds ship inside the npm tarball, so a plain require is the honest
 * probe and works without a TTY.
 */
export const NATIVE_MODULE_SMOKES: ReadonlyArray<{ name: string; smoke: string }> = [
  { name: 'better-sqlite3', smoke: "new (require(process.argv[1]))(':memory:')" },
  { name: 'node-pty', smoke: 'require(process.argv[1])' },
]

/**
 * The one dependency whose install script must run for the install to work
 * (prebuild-install lays down better_sqlite3.node). Passed to npm as
 * --allow-scripts=… so npm 12+ doesn't block it; older npms silently ignore
 * the unknown flag (verified on npm 10.9.8). node-pty is deliberately absent:
 * its prebuilds are pre-packaged, no install script needed.
 */
export const ALLOW_SCRIPTS = 'better-sqlite3'

/**
 * Smoke-test the native modules of the package installed at `pkgRoot`
 * (<npm root -g>/@turmind/halo). Returns the names that failed — module dir
 * missing (package never landed) or smoke expression threw (binding missing,
 * ABI mismatch). Empty array = all good.
 */
export function verifyNativeModules(pkgRoot: string): string[] {
  const broken: string[] = []
  for (const { name, smoke } of NATIVE_MODULE_SMOKES) {
    const modDir = path.join(pkgRoot, 'node_modules', name)
    if (!fs.existsSync(modDir)) {
      broken.push(name)
      continue
    }
    const probe = spawnSync(process.execPath, ['-e', smoke, modDir], { encoding: 'utf-8' })
    if (probe.error || probe.status !== 0) broken.push(name)
  }
  return broken
}
