import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyNativeModules, NATIVE_MODULE_SMOKES } from '../src/upgrade-verify.js'

/**
 * Contract for `halo upgrade`'s post-install native-module smoke check.
 * The scenario it exists for: npm 12's allowScripts blocks better-sqlite3's
 * install script, npm exits 0, the package dir lands but the binding file
 * doesn't — require() still succeeds (the addon loads lazily in the Database
 * constructor), so only a real constructor call catches it. Three branches
 * must hold: missing module dir → broken, probe throws → broken, working
 * module → pass. Fixtures are real packages in a temp dir — the probe runs
 * in a genuine child process, nothing is mocked.
 */

let pkgRoot: string

/** Lay down a fake installed module at <pkgRoot>/node_modules/<name>. */
function writeModule(name: string, indexJs: string): void {
  const dir = path.join(pkgRoot, 'node_modules', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js' }))
  fs.writeFileSync(path.join(dir, 'index.js'), indexJs)
}

// A constructor that works — satisfies better-sqlite3's `new (require(…))(':memory:')` probe.
const WORKING_CTOR = 'module.exports = class FakeDb { constructor() {} }\n'
// Loads fine but blows up on construction — better-sqlite3's exact failure
// mode when the binding file is missing (lazy addon load in the constructor).
const LAZY_BROKEN_CTOR =
  "module.exports = class FakeDb { constructor() { throw new Error('Could not locate the bindings file.') } }\n"
// Throws at require time — node-pty's failure mode (eager pty.node load).
const EAGER_BROKEN = "throw new Error('Failed to load native module: pty.node')\n"

beforeEach(() => {
  pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-upgrade-verify-'))
})

afterEach(() => {
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})

describe('verifyNativeModules', () => {
  it('passes when every native module loads and constructs', () => {
    writeModule('better-sqlite3', WORKING_CTOR)
    writeModule('node-pty', 'module.exports = {}\n')
    expect(verifyNativeModules(pkgRoot)).toEqual([])
  })

  it('reports a module whose directory is missing entirely', () => {
    // node_modules/ exists but neither module dir does (install never landed).
    fs.mkdirSync(path.join(pkgRoot, 'node_modules'), { recursive: true })
    expect(verifyNativeModules(pkgRoot)).toEqual(['better-sqlite3', 'node-pty'])
  })

  it('reports better-sqlite3 when the probe throws (missing binding, npm-12 allowScripts case)', () => {
    writeModule('better-sqlite3', LAZY_BROKEN_CTOR)
    writeModule('node-pty', 'module.exports = {}\n')
    expect(verifyNativeModules(pkgRoot)).toEqual(['better-sqlite3'])
  })

  it('reports node-pty when require itself throws', () => {
    writeModule('better-sqlite3', WORKING_CTOR)
    writeModule('node-pty', EAGER_BROKEN)
    expect(verifyNativeModules(pkgRoot)).toEqual(['node-pty'])
  })

  it('probes better-sqlite3 with a constructor call, not a bare require', () => {
    // Guard against weakening the smoke to `require(…)` — a bare require
    // false-passes on a binding-less better-sqlite3 (verified on 11.10.0 and
    // 13.0.3). If this expression stops constructing, that regression is back.
    const smoke = NATIVE_MODULE_SMOKES.find((m) => m.name === 'better-sqlite3')!.smoke
    expect(smoke).toContain('new ')
  })
})
