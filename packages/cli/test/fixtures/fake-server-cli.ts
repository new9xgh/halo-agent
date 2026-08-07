/**
 * Stand-in for the `halo` binary, used by server-supervisor.test.ts to exercise
 * the real respawn loop against real child processes.
 *
 * The supervisor re-execs `process.argv[0] <process.argv[1]> server start`, so a
 * script that plays both roles depending on its argv reproduces the production
 * topology exactly — no test-only hook in the supervisor itself:
 *
 *   node fake-server-cli.ts              → the supervisor (superviseServer())
 *   node fake-server-cli.ts server start → the "server" (exits FAKE_SERVER_EXIT)
 *
 * The spawned child inherits NODE_OPTIONS=--import tsx from the test, which is
 * what lets this stay TypeScript.
 */
if (process.argv[2] === 'server' && process.argv[3] === 'start') {
  console.log('[fake-server] starting')
  process.exit(Number(process.env.FAKE_SERVER_EXIT ?? '1'))
}

const { superviseServer } = await import('../../src/server-supervisor.js')
await superviseServer()
