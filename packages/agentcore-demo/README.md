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
| `GET /ping` | `{"status":"healthy"}` |
| `POST /invocations` | `{"input":{"prompt":"..."}}` → `{"output":{"message":{"role":"assistant","content":[{"text":"..."}]}}}` |
| `WS /ws` | send `{"inputText":"..."}` / `{"type":"stop"}`; receive `{"type":"stream"\|"thinking"\|"tool_call"\|"tool_result"\|"queued"\|"complete"\|"error", ...}` frames |

Session identity: the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header
(set by AgentCore) or a `sessionId` query param (browsers). The same id maps
to the same persistent Halo session — reload the page, keep the conversation.

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
# {"status":"healthy"}

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

Model / provider selection, skills, and agent profiles are standard halo
configuration under `~/.halo/` — see the main repo docs.

---

Built with [Halo](https://github.com/turmind/halo-agent) — Multi-agent
collaborative workspace.
