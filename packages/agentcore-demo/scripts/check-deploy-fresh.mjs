// Gate: deploy/ (the pnpm-deployed cli tree COPY'd into the Docker image) is a
// manually regenerated artifact — nothing rebuilds it automatically, so a
// forgotten regen silently bakes a stale halo into the AgentCore image. Compare
// its package version against the workspace cli before any image build.
//
// Wired into cdk/bin/app.ts (fires on every `cdk synth` / `cdk deploy`); for a
// manual `docker build`, run `node scripts/check-deploy-fresh.mjs` first.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEPLOY_PKG = path.join(__dirname, '..', 'deploy', 'package.json')
const CLI_PKG = path.join(__dirname, '..', '..', 'cli', 'package.json')

const REGEN_HINT = `Regenerate it from the repo root (after building the workspace):
  pnpm build
  rm -rf packages/agentcore-demo/deploy
  pnpm deploy --legacy --filter @turmind/halo-cli --prod packages/agentcore-demo/deploy`

export function checkDeployFresh() {
  if (!fs.existsSync(DEPLOY_PKG)) {
    throw new Error(`[agentcore-demo] deploy/ is missing (it is gitignored — a fresh checkout does not have it).\n${REGEN_HINT}`)
  }
  const deployVersion = JSON.parse(fs.readFileSync(DEPLOY_PKG, 'utf8')).version
  const cliVersion = JSON.parse(fs.readFileSync(CLI_PKG, 'utf8')).version
  if (deployVersion !== cliVersion) {
    throw new Error(
      `[agentcore-demo] deploy/ is stale: it holds @turmind/halo-cli ${deployVersion} but the workspace is at ${cliVersion}. ` +
      `Building the image now would ship the old cli.\n${REGEN_HINT}`,
    )
  }
  console.log(`[agentcore-demo] deploy/ is fresh (@turmind/halo-cli ${deployVersion})`)
}

// Runnable standalone: node scripts/check-deploy-fresh.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkDeployFresh()
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
