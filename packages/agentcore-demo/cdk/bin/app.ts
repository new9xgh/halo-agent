#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { HaloAgentCoreStack } from '../lib/halo-agentcore-stack.js'

const app = new cdk.App()
new HaloAgentCoreStack(app, 'HaloAgentCoreDemo', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
})
