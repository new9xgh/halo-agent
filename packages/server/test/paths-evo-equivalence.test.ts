import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  wsEvoDir,
  wsEvoRunDir,
  wsEvoSandboxDir,
  wsEvoApplyDir,
  wsEvoArchiveDir,
  wsEvoArchivedRunZip,
  wsEvoArchivedApplyZip,
  wsEvoHistoryDir,
  evoSandboxDir,
  evoSandboxHaloDir,
  evoRegressDir,
  evoRegressRunDir,
  evoLogsDir,
  evoWrapperLogFile,
  evoApplyLogFile,
} from '../src/paths.js'

/**
 * Contract (B-#4a): every evo path used to be hand-joined at ~25 call sites in
 * `evolution/{archive,enqueue,evo-wrapper}.ts` and `routes/evolution.ts`. Those
 * are now all routed through `paths.ts`. The migration is only safe if the
 * builders emit byte-identical strings — a run dir that shifts by one segment
 * orphans every artifact of every in-flight evolution on an existing install,
 * silently (the reader just sees an empty dir).
 *
 * So this file pins each builder against the literal `path.join(...)` shape
 * that was deleted from the call site, copied verbatim from the pre-migration
 * source. It is deliberately dumb duplication: it is the only thing that would
 * catch a "harmless" layout tidy-up in paths.ts.
 */

const WS = '/tmp/halo-test-ws'
const RUN_ID = 'run_abc123'
const APPLY_ID = 'apply_def456'

describe('paths.ts evo builders match the pre-migration hand-joined paths', () => {
  it('workspace-scoped run / apply / archive / history dirs', () => {
    // evolution/archive.ts, evolution/enqueue.ts, routes/evolution.ts
    expect(wsEvoDir(WS)).toBe(path.join(WS, '.halo', 'evo'))
    expect(wsEvoRunDir(WS, RUN_ID)).toBe(path.join(WS, '.halo', 'evo', 'runs', RUN_ID))
    expect(wsEvoApplyDir(WS, APPLY_ID)).toBe(path.join(WS, '.halo', 'evo', 'applies', APPLY_ID))
    expect(wsEvoArchiveDir(WS)).toBe(path.join(WS, '.halo', 'evo', 'archive'))
    expect(wsEvoArchivedRunZip(WS, RUN_ID)).toBe(path.join(WS, '.halo', 'evo', 'archive', `run-${RUN_ID}.zip`))
    expect(wsEvoArchivedApplyZip(WS, APPLY_ID)).toBe(path.join(WS, '.halo', 'evo', 'archive', `apply-${APPLY_ID}.zip`))
    // evo-wrapper.ts phaseApplyPreflight built this off `mainHalo`
    expect(wsEvoHistoryDir(WS, APPLY_ID)).toBe(path.join(WS, '.halo', 'evo', 'history', `apply-${APPLY_ID}`))
  })

  it('artifact-dir-relative sandbox / regress dirs, both run and apply mode', () => {
    const runDir = path.join(WS, '.halo', 'evo', 'runs', RUN_ID)
    const applyDir = path.join(WS, '.halo', 'evo', 'applies', APPLY_ID)

    // phaseDraft / tryDryRun / runFix / phaseScore (run mode)
    expect(evoSandboxDir(runDir)).toBe(path.join(runDir, 'sandbox'))
    expect(evoSandboxHaloDir(runDir)).toBe(path.join(runDir, 'sandbox', '.halo'))
    // phaseApplyMerge / phaseApplyRegress / phaseApplyPreflight (apply mode)
    expect(evoSandboxDir(applyDir)).toBe(path.join(applyDir, 'sandbox'))
    expect(evoSandboxHaloDir(applyDir)).toBe(path.join(applyDir, 'sandbox', '.halo'))
    expect(evoRegressDir(applyDir)).toBe(path.join(applyDir, 'regress'))
    expect(evoRegressRunDir(applyDir, RUN_ID)).toBe(path.join(applyDir, 'regress', RUN_ID))

    // the (workspace, runId) shorthand must land on the same sandbox as the
    // artifact-dir form — buildEvoSandbox is called with either
    expect(wsEvoSandboxDir(WS, RUN_ID)).toBe(evoSandboxDir(wsEvoRunDir(WS, RUN_ID)))
    expect(wsEvoSandboxDir(WS, RUN_ID)).toBe(path.join(WS, '.halo', 'evo', 'runs', RUN_ID, 'sandbox'))
  })

  it('global wrapper log files (routes/evolution.ts reads these back by name)', () => {
    const logsDir = path.join(homedir(), '.halo', 'global', 'logs', 'evo')
    expect(evoLogsDir()).toBe(logsDir)
    // openLogFor used `${mode}-${id}.log` with mode 'run' | 'apply'
    expect(evoWrapperLogFile(RUN_ID)).toBe(path.join(logsDir, `run-${RUN_ID}.log`))
    expect(evoApplyLogFile(APPLY_ID)).toBe(path.join(logsDir, `apply-${APPLY_ID}.log`))
  })
})
