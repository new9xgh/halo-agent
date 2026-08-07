#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { HaloAgentCoreStack } from '../lib/halo-agentcore-stack.js'
// @ts-expect-error plain .mjs helper, no type declarations
import { checkDeployFresh } from '../../scripts/check-deploy-fresh.mjs'

// Fail synth/deploy up front when deploy/ (the halo tree baked into the
// image) is missing or holds an older cli than the workspace.
checkDeployFresh()

const app = new cdk.App()
new HaloAgentCoreStack(app, 'HaloAgentCoreDemo', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
