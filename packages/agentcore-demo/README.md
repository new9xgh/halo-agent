# Halo on Amazon Bedrock AgentCore Runtime

Run the [Halo](https://github.com/turmind/halo-agent) agent server as a
serverless container on **Amazon Bedrock AgentCore Runtime**, with a
streaming WebSocket chat frontend.

```
Browser (demo frontend, CloudFront)
   │  wss  (auth terminated by AgentCore — OAuth / presigned URL)
   ▼
Amazon Bedrock AgentCore Runtime
   │  transparent forward, per-session microVM
   ▼
Halo server container  :8080
   ├── GET  /ping           health check
   ├── POST /invocations    request/response invoke
   └── WS   /ws             bidirectional streaming (primary path)
```

Halo implements the AgentCore contract when started with
`HALO_RUNTIME_MODE=agentcore`:

| Endpoint | Behavior |
|---|---|
| `GET /ping` | `{"status":"Healthy"}`, or `{"status":"HealthyBusy"}` while any agent session is running — AgentCore keeps busy sessions alive past the idle timeout |
| `POST /invocations` | `{"input":{"prompt":"..."}}` → `{"output":{"message":{"role":"assistant","content":[{"text":"..."}]}}}` |
| `WS /ws` | send `{"inputText":"..."}` / `{"type":"stop"}`; receive `{"type":"stream"\|"thinking"\|"tool_call"\|"tool_result"\|"queued"\|"complete"\|"error", ...}` frames |

Session identity: the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header
(set by AgentCore) or a `sessionId` query param (browsers). Each runtime
session id maps to its **own workspace** under
`HALO_WORKSPACE/users/<sanitized-id>/` with an isolated `.halo/` (sqlite +
session files) — use one id per user and users never see each other's
history. Reload the page with the same id, keep the conversation.

In this mode the server skips admin password/JWT auth (AgentCore terminates
auth upstream), messaging channels (telegram/wechat/slack/feishu), cron and
evolution subsystems, and the single-instance lock (one microVM per session).

## What's in here

- `index.html` — the demo chat frontend. Single file, no build step: dark
  theme, markdown rendering, token streaming, collapsible thinking / tool-call
  steps, mid-reply follow-up messages (server-side queueing) and a Stop button.
- `Dockerfile` — Halo server as an AgentCore container (ARM64, port 8080).
- `cdk/` — AWS CDK stack: ECR image build+push, VPC (private subnets + NAT),
  EFS workspace, IAM role, AgentCore Runtime, S3 + CloudFront for the
  frontend.

## Local test (no AWS needed)

Prerequisites: Docker (or a local halo install).

```bash
# Option A: docker
cd packages/agentcore-demo
docker build --platform linux/arm64 -t halo-agentcore .
docker run -p 8080:8080 \
  -v "$PWD/workspace:/mnt/workspace" \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION \
  halo-agentcore

# Option B: from a dev checkout
HALO_RUNTIME_MODE=agentcore HALO_PORT=8080 HALO_WORKSPACE=$PWD/workspace \
  node packages/server/dist/index.js
```

Then open `index.html` directly in a browser (double-click, or
`python3 -m http.server 9000`). It defaults to `ws://localhost:8080/ws`.

Quick smoke test without the frontend:

```bash
curl http://localhost:8080/ping
# {"status":"Healthy"}

curl -X POST http://localhost:8080/invocations \
  -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: test-1' \
  -d '{"input":{"prompt":"hello"}}'
```

> Model credentials: the container needs Bedrock (or other provider) access.
> Locally pass AWS creds via env as above; on AgentCore the runtime IAM role
> provides them. Model/provider selection follows normal halo configuration
> (`~/.halo/` inside the container — bake `halo setup` answers into the image
> or mount your own config).

## Deploy to AWS

Prerequisites:

- AWS account + credentials configured (`aws sts get-caller-identity` works)
- Node.js 22+, Docker (ARM64 cross-build via buildx)
- AWS CDK CLI: `npm i -g aws-cdk`, and a bootstrapped environment
  (`cdk bootstrap`)
- Amazon Bedrock model access enabled in your region (e.g. Claude)

```bash
cd packages/agentcore-demo
npm install          # installs aws-cdk-lib etc. for the cdk app
cd cdk
cdk deploy
```

The stack outputs:

| Output | Use |
|---|---|
| `DemoUrl` | CloudFront URL of the demo frontend — open in a browser |
| `CloudFrontDistributionId` | for attaching a custom domain / WAF later |
| `AgentRuntimeArn` | **backend/SDK only** — never embed in the frontend |
| `AgentCoreWsEndpoint` | WS endpoint template for frontend configuration |

### Wiring the frontend to the runtime

Browsers can't set an `Authorization` header on WebSocket connections, so the
frontend must receive an **authenticated WS URL** (presigned URL or
query-param token per your AgentCore auth configuration) from your own
backend. Inject it into the page:

```html
<script>
  window.__CONFIG__ = { wsEndpoint: 'wss://<your-authenticated-endpoint>/ws' }
</script>
```

(or serve a small `/config.js` from your backend). For quick tests the page
also accepts `?ws=wss://.../ws` as a query parameter.

The demo ships without any endpoint baked in and falls back to
`ws://localhost:8080/ws`, so a fork works locally out of the box.

### Custom domain & access control

The stack works out of the box on the default CloudFront domain. To use your
own domain:

```bash
cdk deploy -c domainName=demo.example.com \
           -c certificateArn=arn:aws:acm:us-east-1:...:certificate/...
```

(the ACM cert must be in `us-east-1` — CloudFront requirement — and you add
the CNAME yourself). Access restrictions (WAF, Cognito, IP allowlists, …) are
similarly the operator's choice; attach them to the CloudFront distribution.

### Network

The runtime runs in **VPC mode**: private subnets (`PRIVATE_WITH_EGRESS`)
with a NAT gateway in the public subnet for outbound traffic (Bedrock API,
external APIs). The NAT gives a stable egress IP — attach an Elastic IP if a
downstream service needs an allowlist. Security groups are least-privilege:
the runtime SG allows outbound 443 + 2049 (EFS, added automatically by the
EFS connection rule); the EFS SG only accepts 2049 from the runtime SG.
EFS mount targets are created per-AZ in the same private subnets.

### Storage

The workspace is an **EFS access point** mounted at `/mnt/workspace`
(`HALO_WORKSPACE`). It's permanent storage — user workspaces persist across
sessions and deployments, unlike AgentCore's managed session storage which
expires with the session. The POC stack sets `RemovalPolicy.DESTROY` on the
filesystem; switch to `RETAIN` before putting real data on it.

## Configuration

| Env | Meaning | Default |
|---|---|---|
| `HALO_RUNTIME_MODE` | `agentcore` enables the adapter | unset (normal server) |
| `HALO_PORT` | listen port | `8080` in the image (halo default 9527) |
| `HALO_WORKSPACE` | agent workspace directory | cwd |
| `HALO_LOG_LEVEL` | set `info` so server logs reach CloudWatch (see Gotchas) | `warn` |

Model / provider selection, skills, and agent profiles are standard halo
configuration under `~/.halo/` — see the main repo docs.

## Operational notes & gotchas

Everything below was learned the hard way running this demo. Read before
operating or debugging a deployment.

### Session lifecycle (when does a session die?)

Three ways a runtime session terminates:

| Trigger | Detail |
|---|---|
| Idle timeout | `/ping` returns `Healthy` (idle) for longer than `idleRuntimeSessionTimeout` → terminated. |
| Max lifetime | `maxLifetime` (default 8h) is a hard cap — even a continuously-busy session is force-terminated. |
| Failed health check | `/ping` erroring / non-200 → terminated. |

Points that are easy to get wrong:

- **An open WebSocket keeps the session alive.** A hanging WS stream is an
  in-flight invocation from the platform's perspective, so the session never
  counts as idle while the socket is open. The frontend's 30s keepalive ping
  exists to stop the AgentCore proxy from cutting an idle socket — which, in
  turn, keeps the session warm. Net effect: idle timeout ≈ "time after the
  tab closes", not "time since the last message".
- **`HealthyBusy` is the official keep-alive** for background work without an
  open connection. This server returns it whenever any agent session is
  running, so long tool chains survive the idle timeout.
- **Never put a current timestamp in `time_of_last_update` on every ping** —
  that signals a continuous status change, the idle timeout never fires,
  sessions pile up until `maxLifetime` and exhaust the concurrent-session
  quota.
- Session data lives on EFS, so termination is cheap: the next connect
  cold-starts a fresh microVM (~3s) and history reloads from disk.

### Observing and managing sessions

There is **no list/get-runtime-sessions API**. What exists:

```bash
# Concurrent session count — CloudWatch metric (1-min granularity, ~1-2 min lag)
aws cloudwatch get-metric-data --region <region> ... \
  # namespace AWS/Bedrock-AgentCore, metric Sessions / ActiveStreamingConnections,
  # dimensions Resource=<runtime-arn>, Operation=InvokeAgentRuntimeWithWebSocketStream

# Per-session activity — filter the runtime log group for the session id
aws logs filter-log-events --region <region> \
  --log-group-name "/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT" \
  --filter-pattern '"<session-id>"' \
  --start-time $(( $(date +%s) * 1000 - 21600000 ))

# Kill one session immediately (data on EFS survives; next connect cold-starts)
aws bedrock-agentcore stop-runtime-session \
  --agent-runtime-arn <runtime-arn> \
  --runtime-session-id <session-id> --region <region>
```

(`date +%s%3N` is GNU-only — the `* 1000` form above works on macOS too.)

### Logging to CloudWatch

AgentCore captures container **stdout** into
`/aws/bedrock-agentcore/runtimes/<runtime-id>-DEFAULT`. Halo's logger
intercepts `console.*` and drops entries below the configured level *before*
they reach stdout — at the default `warn`, CloudWatch shows almost nothing.
Set `HALO_LOG_LEVEL=info` (baked into the Dockerfile here).

### update-agent-runtime pitfalls

- The call **replaces the full configuration** — omitting
  `--filesystem-configurations` silently drops the EFS mount. Always fetch
  the current config (`get-agent-runtime`), modify, and send everything back.
- Runtimes created after 2026-06 reject `requireServiceS3Endpoint` inside
  `networkModeConfig` on update — strip it from the fetched config first.
- Every update bumps the runtime version and rolls new sessions to it;
  existing live sessions keep the old version until they terminate.

### VPC networking

The runtime gets **no public IP** in VPC mode. Private subnets must have a
route `0.0.0.0/0 → NAT gateway`, or every outbound call (Bedrock, npm, ...)
hangs and invocations fail with opaque 502s. If the frontend suddenly gets
502 on connect after an infra change, check the private route table first.

### Frontend / WS proxy quirks

- The AgentCore WS proxy only forwards frames containing `inputText` — it
  won't push server-initiated frames on connect, so the frontend must send
  `{"inputText":"/init"}` after open to fetch history (the server treats it
  as a protocol message, not a prompt).
- The proxy cuts idle WS connections after ~1 min; the frontend sends a
  `{type:'ping'}` keepalive every 30s (the server silently ignores frames
  without `inputText`).
- Browsers can't set headers on WS connections, so auth rides a **presigned
  URL** minted by a small Lambda (see `lambda/ws-presign/`) — the presigned
  URL embeds the session id and expires in 5 minutes; mint a fresh one per
  (re)connect.

---

Built with [Halo](https://github.com/turmind/halo-agent) — Multi-agent
collaborative workspace.
