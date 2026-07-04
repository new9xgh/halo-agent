# Halo server as an Amazon Bedrock AgentCore Runtime container.
#
# AgentCore contract: listen on :8080, GET /ping health check,
# POST /invocations, WebSocket /ws. All implemented by the halo server
# when HALO_RUNTIME_MODE=agentcore.
#
# AgentCore runs ARM64 containers — build with:
#   docker build --platform linux/arm64 -t halo-agentcore .
FROM --platform=linux/arm64 node:22-slim

# Native module toolchain (better-sqlite3 / node-pty build from source when
# no prebuilt binary matches) + git for the workspace git tooling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install halo from a pre-built pnpm deploy directory (includes all workspace
# deps resolved). `pnpm --filter @turmind/halo-cli deploy deploy-out --prod --legacy`
# produces the directory. Native modules must be rebuilt for ARM64 since the
# deploy was produced on the host (likely x86_64).
COPY deploy/ /opt/halo
RUN cd /opt/halo \
  && npm rebuild better-sqlite3 \
  && npm rebuild @parcel/watcher \
  && npm link

# Seed ~/.halo templates/config non-interactively. Global config (models,
# agents, skills) is baked into the image; per-user data lives under
# HALO_WORKSPACE (EFS mount) — each runtime session id gets its own
# users/<id>/ workspace with its own .halo/ (sqlite + session files).
# The runtime deploys in ap-northeast-1 — point the seeded agents' Bedrock
# endpoint there (global.* inference profiles are available in Tokyo).
RUN halo setup --non-interactive \
  && sed -i 's|bedrock-runtime.us-east-1|bedrock-runtime.ap-northeast-1|g' /root/.halo/global/agents/*/agent.yaml

# EFS mount point (AgentCore filesystemConfigurations → /mnt/efs).
# For local runs bind-mount a directory: docker run -v "$PWD/data:/mnt/efs" ...
RUN mkdir -p /mnt/efs

# HALO_LOG_LEVEL=info: the logger's console interceptor short-circuits below
# the configured level BEFORE writing to stdout — at the default `warn`,
# info-level lines never reach stdout, so AgentCore's CloudWatch capture
# (which reads container stdout) saw nothing but warnings.
ENV HALO_RUNTIME_MODE=agentcore \
    HALO_PORT=8080 \
    HALO_WORKSPACE=/mnt/efs \
    HALO_LOG_LEVEL=info

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8080/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["halo", "server", "start"]
