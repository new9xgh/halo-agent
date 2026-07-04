// auth-server.js — lightweight login API for the AgentCore demo.
// Plain Node http (no express). Looks up users in DynamoDB, verifies
// bcrypt password hashes, issues/verifies JWTs.
//
// POST /api/login  { username, password } -> { token, userId, displayName }
// GET  /api/verify Authorization: Bearer <jwt> -> { userId, displayName }

import { createServer } from 'node:http'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const PORT = 18089
const AUTH_SECRET = process.env.AUTH_SECRET || 'agentcore-demo-secret'
const TABLE_NAME = 'agentcore-demo-users'
const REGION = 'ap-northeast-1'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function handleLogin(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { error: 'invalid JSON body' })
  }
  const { username, password } = body
  if (!username || !password) {
    return sendJson(res, 400, { error: 'username and password required' })
  }

  const { Item: user } = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { username } }))
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return sendJson(res, 401, { error: 'invalid username or password' })
  }

  const token = jwt.sign({ userId: user.userId, displayName: user.displayName }, AUTH_SECRET, { expiresIn: '24h' })
  sendJson(res, 200, { token, userId: user.userId, displayName: user.displayName })
}

async function handleVerify(req, res) {
  const authHeader = req.headers['authorization'] || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!token) return sendJson(res, 401, { error: 'missing bearer token' })

  try {
    const payload = jwt.verify(token, AUTH_SECRET)
    sendJson(res, 200, { userId: payload.userId, displayName: payload.displayName })
  } catch {
    sendJson(res, 401, { error: 'invalid or expired token' })
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'POST' && pathname === '/api/login') {
      await handleLogin(req, res)
    } else if (req.method === 'GET' && pathname === '/api/verify') {
      await handleVerify(req, res)
    } else {
      sendJson(res, 404, { error: 'not found' })
    }
  } catch (err) {
    console.error('[AuthServer] request failed:', err)
    sendJson(res, 500, { error: 'internal error' })
  }
})

server.listen(PORT, () => {
  console.log(`[AuthServer] listening on port ${PORT}`)
})
