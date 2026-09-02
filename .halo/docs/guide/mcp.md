# MCP Servers — User Guide

Halo has a built-in MCP (Model Context Protocol) client. Declare a server once in YAML and its tools are injected into every agent session — all providers, no per-agent config.

## Manage servers in the admin UI

Click the **MCP** icon (plug) in the Activity Bar — same row as Agents/Skills. The panel lists every declared server grouped by scope (Global / Workspace) with its transport, description, live tool count (once connected), and an enable/disable toggle. From here you can:

- **Create**: `+` button → enter an id → the editor opens with a scaffold; fill in the transport fields.
- **Edit**: two views — **Form** (transport dropdown, command/args/env or url/headers key-value editors, description) and **YAML** (Monaco, edits the raw file). Both auto-save after 500ms; the two views share one document.
- **Test connection**: the probe button connects and lists the server's tools (read-only ones are marked), or shows the connection error.
- **Enable/disable**: the toggle flips the yaml `enabled` field — disabled servers stay in the list, dimmed.
- **Delete**: hover a row → trash icon.

Everything the UI does is equivalent to editing the yaml files below by hand — the panel reads and writes the same files, so both workflows mix freely.

## Declare a server

One file per server, in either scope:

- **Global**: `~/.halo/global/mcp/<serverId>.yaml` — shared across projects
- **Workspace**: `<project>/.halo/mcp/<serverId>.yaml` — project-private; a file with the same name **replaces** the global one (file-level override)

Changes take effect on the next new session — no server restart needed.

### stdio server (local command)

```yaml
id: github                          # required; matches the filename
transport: stdio                    # stdio (default) | http
command: npx                        # required for stdio
args: ["-y", "@modelcontextprotocol/server-github"]
env:
  GITHUB_TOKEN: "<<GITHUB_TOKEN>>"  # <<ENV>> placeholders expanded at load time
```

### Remote server (streamable HTTP)

```yaml
id: company-hub
transport: http
url: https://mcp.example.com/mcp    # required for http
headers:
  Authorization: "Bearer <<HUB_TOKEN>>"
```

Optional fields: `enabled: false` (keep the file but disable), `description: ...` (operator note).

> **Secrets**: `~/.halo/global/` is visible to agents, so never paste plaintext keys into an MCP yaml. Use `<<ENV_NAME>>` placeholders (expanded from the server process env at load time), the same convention as `settings.yaml`.

## What the agent sees

Each MCP tool becomes a tool named `mcp__<serverId>__<toolName>` — the prefix guarantees no collision with built-in tools. The description is prefixed with `[<serverId>]`. MCP tools:

- **Bypass the `tools:` whitelist** in agent.yaml (like session tools): every non-internal agent in the workspace gets them. Internal agents (`internal: true`, e.g. evo/score/apply) never get MCP tools.
- **Are filtered in readonly sessions**: only tools the server annotated `readOnlyHint: true` are kept — MCP tools are external side effects Halo can't sandbox, so unannotated ones are withheld rather than trusted.
- Appear in `/context` metadata and the "Your available tools" prompt tail like any other tool.

## Lifecycle and failure behavior

- One connection per (workspace, server) is pooled and reused across sessions; editing a server's yaml drops the stale connection and reconnects on next use.
- Connect/list has a 10s timeout. A server that fails to start or answer is **skipped** with a `[mcp] Skipping server "<id>"` log line — it never blocks session creation, and other servers are unaffected.
- stdio servers run as child processes with the workspace as cwd; they exit when the Halo server exits.

## Scope: tools only

Only MCP **tools** are bridged. Resources, prompts, sampling, and elicitation are not currently surfaced.

## vs. the aws-knowledge skill

The built-in `aws-knowledge` skill predates this feature: it wraps one specific remote MCP server (AWS docs) in a hand-rolled script the agent runs via `shell_exec`. Prefer declaring servers here — native tools beat shell-wrapped scripts (typed schemas, image results, error markers, no prompt coaching needed). The skill remains for convenience and as an example of the script approach.
