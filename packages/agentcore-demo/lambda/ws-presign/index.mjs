// index.mjs — Lambda handler that mints a presigned AgentCore Runtime
// WebSocket URL for the demo frontend (browsers can't SigV4-sign WS
// connections themselves).
//
// GET /api/ws-presign?sessionId=<id>
//   -> { wsUrl, sessionId, expiresIn }
//
// The runtime lives in AGENTCORE_REGION (us-east-1) regardless of which
// region this Lambda runs in — signing must target that region/service.

import { SignatureV4 } from '@smithy/signature-v4'
import { HttpRequest } from '@smithy/protocol-http'
import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

const RUNTIME_ARN = process.env.RUNTIME_ARN
const AGENTCORE_REGION = process.env.AGENTCORE_REGION || 'us-east-1'
const EXPIRES_IN = 300
const SESSION_ID_QUERY_PARAM = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'

function response(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export async function handler(event) {
  const sessionId = event.queryStringParameters?.sessionId
  if (!sessionId) {
    return response(400, { error: 'sessionId query param required' })
  }

  try {
    const hostname = `bedrock-agentcore.${AGENTCORE_REGION}.amazonaws.com`
    const encodedArn = encodeURIComponent(RUNTIME_ARN)

    const signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region: AGENTCORE_REGION,
      credentials: defaultProvider(),
      sha256: Sha256,
    })

    const request = new HttpRequest({
      method: 'GET',
      protocol: 'https',
      hostname,
      path: `/runtimes/${encodedArn}/ws`,
      query: { [SESSION_ID_QUERY_PARAM]: sessionId },
      headers: { host: hostname },
    })

    const presigned = await signer.presign(request, { expiresIn: EXPIRES_IN })

    const queryString = Object.entries(presigned.query)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
    const wsUrl = `wss://${hostname}${presigned.path}?${queryString}`

    return response(200, { wsUrl, sessionId, expiresIn: EXPIRES_IN })
  } catch (err) {
    console.error('[WsPresignLambda] presign failed:', err)
    return response(500, { error: 'internal error' })
  }
}
