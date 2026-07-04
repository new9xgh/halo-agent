# AgentCore Runtime Mode

Halo server as an **Amazon Bedrock AgentCore Runtime** container — a fourth
way to run halo (server / CLI / desktop / AgentCore). One env var flips it:
`HALO_RUNTIME_MODE=agentcore`. Demo package: `packages/agentcore-demo/`
(Dockerfile, chat frontend, CDK stack, auth Lambdas — its README carries the
operational gotchas; this doc covers how the mode works inside the server).

```
Browser (static frontend, S3 + CloudFront)
   │  /api/login, /api/verify  → CloudFront /api/* behavior → API GW → auth Lambda (DDB users, JWT)
   │  /api/ws-presign          → presign Lambda (SigV4-signs the AgentCore WS URL)
   │  wss (presigned URL, 5-min TTL)
   ▼
AgentCore Runtime (per-session microVM, auth terminated here)
   │  X-Amzn-Bedrock-AgentCore-Runtime-Session-Id = user UUID
   ▼
halo server :8080  (HALO_RUNTIME_MODE=agentcore)
   ├── GET  /ping          Healthy | HealthyBusy (any running agent session)
   ├── POST /invocations   {"input":{"prompt"}} → full assistant message
   └── WS   /ws            streaming frames (primary path)
```

## What the mode changes (packages/server/src/index.ts)

`config.server.runtimeMode === 'agentcore'` (env `HALO_RUNTIME_MODE`) skips:

- **Password/JWT gate** — AgentCore terminates auth upstream (SigV4 presign /
  OAuth); the container is only reachable through the runtime.
- **Single-instance lock** — one microVM per session; many server processes
  coexist by design.
- **Channels, cron, evolution, archive daemon** — meaningless in an ephemeral
  per-session microVM; sessions are driven only through the AgentCore surface.

Everything else (agent loop, tools, skills, sqlite persistence) is the normal
server. The adapter itself is `packages/server/src/routes/agentcore.ts`,
mounted at the root (the AgentCore contract paths live outside `/api`).

## Per-user workspace isolation

`userWorkspace(base, runtimeSessionId)` maps each runtime session id to
`<HALO_WORKSPACE>/users/<sanitized-id>/` — an isolated workspace with its own
`.halo/` (sqlite + session files). The id chain:

DDB `agentcore-demo-users` UUID → login response → frontend uses it as
sessionId → presign Lambda signs it into
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` → adapter routes the workspace.

So **1 user = 1 runtime session id = 1 workspace**: users never see each
other's history; reconnecting with the same id resumes the same conversation.
`HALO_WORKSPACE` points at an EFS mount (`/mnt/efs`) — microVMs are ephemeral,
EFS makes the workspaces survive session termination and image rollouts.

## WS protocol quirks (why /init exists)

The AgentCore WS proxy only forwards **client frames containing `inputText`**
and cannot push server frames on connect. Hence:

- Frontend sends `{"inputText":"/init"}` after open; the server special-cases
  it (also accepts `{"type":"init"}`) and replies with a `history` frame —
  a full snapshot, which the frontend renders by rebuild-from-scratch (not
  append), keyed by a signature so identical snapshots skip re-rendering.
- Frames without `inputText` are silently ignored server-side — the frontend
  uses `{type:'ping'}` every 30s purely to keep the proxy from cutting the
  socket.
- `/session switch` sends a `{type:'switch'}` frame → frontend clears, then
  the follow-up history frame rebuilds.

## Session lifecycle (the part everyone gets wrong)

- Idle timeout (`idleRuntimeSessionTimeout`) terminates a session whose
  `/ping` reports `Healthy`; `maxLifetime` (8h) force-terminates even busy
  ones; failed health checks kill immediately.
- **An open WebSocket = an in-flight invocation** — the session never counts
  as idle while a socket is open. The 30s frontend keepalive therefore keeps
  the whole session warm; effective idle timeout ≈ "after the tab closes".
- `/ping` returns `HealthyBusy` whenever any agent session is running
  (`registry.list().some(sm => sm.hasRunningSessions())`) — the official
  keep-alive for long tool chains with no open connection.
- Termination is cheap: data is on EFS, next connect cold-starts (~3s) and
  history reloads. `stop-runtime-session` kills one session on demand; there
  is **no list/get-runtime-sessions API** (observe via CloudWatch `Sessions`
  metric + runtime log filtering).

## Ops crib sheet

- CloudWatch logs capture container **stdout**; halo's logger drops
  sub-threshold lines before stdout — set `HALO_LOG_LEVEL=info` or the log
  group stays near-empty.
- `update-agent-runtime` **replaces the whole config** — omit
  `--filesystem-configurations` and the EFS mount silently disappears.
  Fetch-modify-send, and strip `requireServiceS3Endpoint` (rejected on
  newer runtimes).
- VPC mode has no public IP: private subnets need `0.0.0.0/0 → NAT` or all
  egress (Bedrock included) hangs → opaque 502s.
- Full operational detail + deploy walkthrough:
  `packages/agentcore-demo/README.md`.
