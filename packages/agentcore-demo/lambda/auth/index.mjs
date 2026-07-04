// index.mjs — Lambda auth handler for the AgentCore demo (API Gateway HTTP API).
// Same logic as auth-server.js, adapted to the Lambda handler contract.
//
// POST /api/login  { username, password } -> { token, userId, displayName }
// GET  /api/verify Authorization: Bearer <jwt> -> { userId, displayName }

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const AUTH_SECRET = process.env.AUTH_SECRET
const TABLE_NAME = process.env.TABLE_NAME
const REGION = process.env.AWS_REGION || 'ap-northeast-1'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

function response(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function handleLogin(event) {
  let body
  try {
    body = event.body ? JSON.parse(event.body) : {}
  } catch {
    return response(400, { error: 'invalid JSON body' })
  }
  const { username, password } = body
  if (!username || !password) {
    return response(400, { error: 'username and password required' })
  }

  const { Item: user } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { username } }))
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return response(401, { error: 'invalid username or password' })
  }

  const token = jwt.sign({ userId: user.userId, displayName: user.displayName }, AUTH_SECRET, { expiresIn: '24h' })
  return response(200, { token, userId: user.userId, displayName: user.displayName })
}

async function handleVerify(event) {
  const authHeader = event.headers?.authorization || event.headers?.Authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return response(401, { error: 'missing bearer token' })

  try {
    const payload = jwt.verify(token, AUTH_SECRET)
    return response(200, { userId: payload.userId, displayName: payload.displayName })
  } catch {
    return response(401, { error: 'invalid or expired token' })
  }
}

export async function handler(event) {
  const method = event.requestContext?.http?.method
  const path = event.requestContext?.http?.path
  try {
    if (method === 'POST' && path === '/api/login') return await handleLogin(event)
    if (method === 'GET' && path === '/api/verify') return await handleVerify(event)
    return response(404, { error: 'not found' })
  } catch (err) {
    console.error('[AuthLambda] request failed:', err)
    return response(500, { error: 'internal error' })
  }
}
