# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [1.0.1] - 2026-07-20

### Added

- Admin chat panel: session list moved from a popup dropdown to a fixed, collapsible right sidebar (terminal-list style) — toggled by the History button or the empty-state link, open state persisted in `localStorage`; rows support inline rename (Enter/blur commits, Esc cancels).
- Admin chat panel: sub-agent report and compact-summary callouts now have hover Copy/Delete actions like regular user bubbles — Copy strips the marker line and copies the body only; deleted callouts grey out with a "deleted" badge.

### Changed

- Session switching shows real loading driven by the server's `state:snapshot` (replacing a 2s fake timer), with a per-row spinner and a slow-network notice + Retry after 30s (slow is not treated as failure).

## [1.0.0] - 2026-07-18

### Added

- Model providers: Kimi K3 (1M context, always-on thinking via top-level `reasoning_effort`, base64-only vision), MiniMax M3 (1M context, Anthropic-compatible, adaptive thinking, new default for the minimax provider), GPT-5.6 Sol/Terra/Luna on Bedrock Mantle (272K context; new default `gpt-5.6-sol`).
- Model registry: per-model `contextWindow` field across all 28 models / 11 providers; session context budget now resolves `agent.yaml`'s `context.maxTokens` > registry `contextWindow` > the global 200K default.

### Fixed

- Sessions permanently bricked after a provider 4xx on multimodal content (e.g. "Multimodal data is corrupted"): history images are degraded to text placeholders, state is persisted, and the turn retries once.
- Session abort reasons normalized to `AbortError` — Node 22 let a bare-string abort reason escape as an unhandled rejection, producing spurious "Unrecoverable: interrupt" errors.
- Non-vision image mime types are now filtered at input with a warning instead of reaching the provider.

### Removed

- GPT-5.5 and GPT-5.4 retired from the Mantle provider — the 5.6 family covers both, with Terra matching 5.5-level performance at half price.

## [0.2.6] - 2026-07-12

### Added

- Goal Mode: hand off the two roles a user unconsciously plays in long agent collaborations — the pusher ("continue") and the evaluator ("is it actually done?") — to a dedicated judge agent. `/goal create [description]` starts an intake conversation on the current session (which becomes the worker) and mints a peer judge session that dispatches work orders and re-dispatches until acceptance or a guardrail halts it; `/goal status` reports round/cap, elapsed time, no-progress counter, and delegated decisions; `/goal pause` hands control back to the user for manual takeover; `/goal resume` nudges the judge to re-read the spec and continue; `/goal clear` tears down the binding from any state. All five verbs require full access.
- Admin: a goal banner above the chat composer shows live status (intake / running round N/max / paused / halted / done), a `Worker →` button to jump to the worker session, and a 🎯 badge on sessions bound to an active goal. Terminal states (done/halted) are dismissible.

### Fixed

- Goal Mode: the intake kick, resume nudge, and restart-sweep nudge only fed the LLM context and skipped the UI transcript append, leaving the judge's first turn with an empty assistant bubble and no visible record of the user's initial goal description after a reload.
- Goal Mode: `/goal create` and `/goal resume` switch the chat panel to the judge session, but the admin never re-subscribed to the new session's event stream — its streaming replies kept flowing to the old session.
- Goal Mode: deleting the judge session or the worker session left the other side's binding dangling (stale 🎯 badge, banner still showing a goal with no counterpart); both delete paths now dissolve the binding before the row is removed.
- Admin: dismissing a goal banner no longer comes back after a page refresh.

### Changed

- Goal Mode: default round cap lowered from 50 to 10 — a goal that hasn't converged by round 10 is looping, not progressing.
- `shell_exec` default timeout raised from 120s to 600s for long-running commands (builds, test suites, deploys); the tool description now states the effective timeout live from config.

## [0.2.5] - 2026-07-08

### Added

- `GET /api/health` now reports `gitSha` (short sha, `-dirty` suffix on a modified tree) on source builds, so "which commit is deployed?" is one curl away; published bundles keep carrying the sha inside `version` and report `gitSha: null`.

### Fixed

- Workspace-scoped provider secrets (API keys configured per-workspace in Settings) never reached the model call — only the global secrets file was read on the model-call path; workspace overrides now take effect.
- `pnpm run dev` for admin was broken on a fresh clone — the dev script ran `next build && next start`, but `output: 'export'` makes `next start` refuse to serve; switched to `next dev` (Monaco now stages to `public/` via a `--dev` flag), and documented dev mode in `env.md`.
- Server workspace file watcher hardened for Windows: Explorer live-refresh was silently dead (parcel emits realpath-based events while the workspace root was a symlinked path), and switching workspaces could crash the server child (a native subscribe/unsubscribe race plus an MSVC std::regex overflow on long ignore-glob lists). Native ops are now serialized with an epoch guard, and win32 uses exact-match ignore segments instead of regex.
- Admin Explorer: a folder once observed empty was never refetched, so files added inside it later stayed invisible until a full tree refresh — now refetched on every collapsed→expanded transition.
- Desktop (Windows): an orphaned server child survived every quit path except the normal one, keeping `node.exe` locking the install directory and forcing an uninstall prompt on every reinstall — all quit paths now route through a synchronous `taskkill` cleanup, plus an installer pass and crash-reporter minidumps.
- Admin editor: switching between a rendered markdown preview and a text file blanked the pane for a few frames on every switch (forced remount); the editor now stays mounted and swaps Monaco models instead. Markdown outline entries could visually squash together in a short list.
- Builtin agents' `context.maxTokens`/`compressAt` reset to template defaults after a reseed (e.g. every desktop launch) — the merge now preserves the whole context block instead of just the model block.
- Admin Sessions sidebar: renaming a session title flickered the detail panel while typing, caused by a self-sustaining reload loop (bus-driven tree rebuild blurring the rename input, unchanged-value PATCH re-triggering the loop); reloads are now suspended during an open edit and no-op PATCHes are skipped.

## [0.2.4] - 2026-07-06

### Added

- Desktop: Cmd/Ctrl+W closes the active editor tab (same confirm-unsaved path as Alt+W); with no tab open it closes the window, preserving the platform-standard meaning. Browser behaviour unchanged.

### Fixed

- Markdown links now open in a new tab instead of navigating the current page away — admin chat and md preview (in-document `#anchors` still scroll in place), web demo, and AgentCore demo. In the desktop app, external links (including same-tab navigations) open in the system browser via `will-navigate` interception; `about:blank` is allowed again, un-breaking the docx/media Print popup.
- Admin editor: Alt+W close-tab shortcut never fired on macOS — Option+W types '∑' so the `e.key` check couldn't match; now matches on physical `e.code` KeyW.

## [0.2.3] - 2026-07-05

### Fixed

- Admin explorer: dragging a file over a collapsed folder no longer bursts it open in passing — spring-loaded expand after a ~600ms hover (VSCode/Finder behaviour), cancelled on drag-leave; dropping into a collapsed folder still expands it.

## [0.2.2] - 2026-07-05

### Added

- Amazon Bedrock AgentCore runtime mode (`HALO_RUNTIME_MODE=agentcore`): `/ping` + `/invocations` + streaming WS adapter, per-user EFS-backed workspaces, channels/cron/evolution disabled — plus a full demo package (Dockerfile, chat frontend, CDK stack, auth/presign Lambdas) under `packages/agentcore-demo/`.
- Halo City: gentle procedural background music — a quiet music-box pentatonic line, pure Web Audio with zero assets, 🎵/🔇 HUD toggle with localStorage persistence.
- Halo City: desk-slacking idle activities — citizens can play a falling-blocks mini-game on their own monitor or scroll their phone at their desk.
- Web demo rebuilt on the agentcore-demo visual foundation: markdown rendering with streaming typewriter, collapsible thinking/tool blocks, mobile-first layout, and a direct-connect mode (server URL + web token straight from the browser, no proxy).
- Vitest infrastructure for core, cli, and admin (previously only server had tests) — 106 new tests, 345 total across the four packages, CI now runs all four `test` scripts.
- `start_session` tool gains an optional `title` parameter — sub-sessions can have a meaningful sidebar title from creation instead of waiting for auto-generation.
- `halo setup` auto-bind: when a non-Bedrock provider has keys configured, setup offers to rebind built-in agents (default/executor/deep-executor) to that provider. Non-interactive: `HALO_DEFAULT_PROVIDER=<provider>`.

### Fixed

- Halo City: stable desk assignment — `/api/show/state` orders sessions by `updated_at`, which reshuffled desks every poll; citizens now keep one desk for their whole stay and return to it after breaks.
- Halo City: citizens roam within ±4 floors of their home floor instead of trekking the whole tower; deeply-nested sub-agents spawn on their session tree's root floor instead of the lobby; floor panel lists a citizen on their desk floor even while away on a break.
- Web demo: `GET /file` proxy route was missing auth middleware.
- `validatePath` sibling-directory escape: a bare `startsWith(projectRoot)` prefix check let a sibling like `/x/myapp-secret` pass `/x/myapp`'s guard; now matches on a path-segment boundary.
- `validatePath` now resolves symlinks (realpath) — a symlink pointing outside the workspace is rejected instead of silently followed. Windows-compatible (junctions handled).
- `/api/web/file` symlink traversal: the endpoint followed symlinks pointing outside the workspace; now rejects with 403 (dangling symlinks return 404).
- `verifyPassword` degenerate-digest fail-open: a stored hash with an empty/corrupt digest segment caused `timingSafeEqual(empty, empty)` → true, accepting any password. Now rejects if digest length ≠ 32 bytes.
- `/api/metrics` used `getOrCreate` instead of `peek`, causing disk writes and orphan reconciliation from a read-only endpoint. Aligned with `/api/show` (peek + readonly fallback).
- `~/.git-credentials` / `~/.netrc` / `~/.config/gh` added to sandbox hidden list — previously readable by workspace/readonly sessions despite containing plaintext tokens.
- `~/.halo/global/{evo.db,cron.db,internal-sessions/,logs/}` hidden from non-full sessions — prevents cross-workspace metadata leakage.
- `secret: true` skill params now participate in shell_exec output masking (previously only `<<ENV>>`-injected values were masked).
- Brute-force rate limiter now uses socket address by default; XFF only trusted when `server.trust_proxy: true`.
- `settings.yaml` written via admin UI now gets mode 0600 (previously inherited umask 0644); secrets dir gets 0700.
- `sandbox.hidden_dirs` / `hidden_files` / `writable_dirs` marked `globalOnly` in schema — workspace-level overrides are now rejected.
- Cron/evolution child processes no longer inherit `HALO_PASSWORD` / `HALO_JWT_SECRET` in their environment.
- `getCommitFiles` rename detection: `diff-tree` ran without `-M`, so renames surfaced as delete+add pairs instead of a rename.
- Slack bold rendered as italic (`transformProse` pass ordering); corrupt password hash caused a 500 on login instead of a false-negative.
- `path-suggest` doubled the `@file` marker when completing inside a quoted directory path.
- evo phase timeouts (`PHASE_TIMEOUT_SEC` / `DRY_RUN_TIMEOUT_SEC`) widened from 10min to 30min — slow providers were hitting the per-phase SIGTERM during legitimate multi-turn drafts.
- `evolution.level` / `triggers.pre_compact` setting descriptions still referenced the renamed `/note` command (now `/evo`).

### Changed

- Settings schema now declares `agent.max_retries` and `limits.auto_report_chars`, which the code already read but the schema never exposed.
- New setting: `server.trust_proxy` (boolean, default false, globalOnly) — enables XFF-based client IP for rate limiting behind a reverse proxy.
- README revamped for launch: orchestration-focused hero, "Why Halo" section with real screenshots, onboarding fixes (AWS no longer implied required, setup-key-binding callout, curl/SSE example).

## [0.2.1] - 2026-07-03

### Added

- Multi-theme support — dark, light, midnight, warm — synced server-side.
- TUI input overhaul: rewritten line editor, verbose mode, persistent history across sessions.
- Speaker-notes sidebar for the PPTX preview, with resilient loading.
- Claude Fable 5 model on the AWS Bedrock Invoke provider.
- `--header` flag on the ACP adapter to forward arbitrary headers for upstream auth.

### Fixed

- Interrupted tool calls are now synthesized into a proper `tool_result` and surfaced in the session UI, instead of being stripped or shown as orphaned.
- Sub-session events enriched with `fullText` and `toolName`.
- Workspace runtime lock prevents cross-server orphan reconciliation.
- Read-only workspace peek for `/api/show`.
- `glob`/`grep` no longer follow Windows junctions into infinite recursion.
- CLI bundling now builds workspace deps first so their `dist` can't go stale.
- `setup` honors `HALO_PASSWORD` at the startup gate, uses real env placeholders, exits non-zero on stdin EOF.
- Internal-agent evolution prompts aligned with fresh-session reality + `ABORT.md` protocol.

### Changed

- Halo City: viewport culling, offscreen skyline, memoized palettes — smooth on busy servers.
- Deterministic team roster ordering + tighter self-delegation guidance.
- Agent guidance and workspace-conventions prompt updates.

## [0.2.0] - 2026-07-01

### Added

- Desktop: agent status light, dynamic title, unfocused-finish notification; multi-window support (Cmd/Ctrl+N) sharing one server.
- Admin: finished-notification chime (decoupled from window focus), off-by-default toggle, extended to the web/browser.
- Admin/Explorer: recent-workspaces dropdown, "Reveal in File Manager" action.
- ACP: support an https upstream via `--scheme`.
- Claude Sonnet 5 model; executor default switched to it.

### Fixed

- `halo acp` no longer rejects its own subcommand or boots a redundant server.
- `better-sqlite3` ABI pinned to the bundled Node version on desktop, with a build guard.
- Collapsible chat content re-measures with a `ResizeObserver`; terminal bottom panel renders once and is portaled between slots.

## [0.1.9] - 2026-06-30

### Fixed

- Release bundling excludes local-only docs and hardens bundle filtering.

### Changed

- Packaging docs gain a version-lockstep gate in the build checklist.
- `/evo` command references and login password steps corrected in docs.

## [0.1.8] - 2026-06-29

### Fixed

- Monaco-less admin bundles (missing `copy-monaco.mjs` step) and the template reseed gate.

### Added

- Packaging docs: core-before-server build order requirement, `pnpm --filter ... build` for admin.

## [0.1.7] - 2026-06-29

### Added

- Source Control panel: git backend with credential/SSH management, multiple HTTPS credentials per host, tiered branch badges, infinite-scroll log, SSH key unlock via in-app dialog.
- Session tools scoped to the caller's own session tree (by-id lookups).

### Fixed

- Sandbox force-kills `setsid`-escaped workers so `shell_exec` can't hang forever.
- Delegation roster collapses shadowed agents and hides disabled/overridden agents from the Team picker.

### Changed

- Chat exchange rows memoized so streaming doesn't re-render the whole log.

## [0.1.6] - 2026-06-27

### Added

- Session titles surfaced in `session_list` output; sub-agent sessions can be renamed inline.
- Per-call model request timeout (default 30min, `HALO_MODEL_TIMEOUT` override).

### Fixed

- Self-compact instruction no longer leaks into the kept tail of a session.
- Halo City citizens stay on their home floor instead of drifting downward.

### Changed

- `list_agents` replaced by a team-scoped delegation roster.

## [0.1.5] - 2026-06-22

### Changed

- `session.output` split into full-text and auto-report-summary variants.

## [0.1.4] - 2026-06-21

### Added

- `/session info`, command aliases (`/w`, `/sn`, agent switch/list shortcuts), `/workspace` rename from `/ws`.
- Root prompt surfaces sibling sub-agent running status.
- Admin-only inline session title rename.

### Fixed

- Sub-session logs keyed by `agentId` instead of case-split directories.
- All model providers retry transient 5xx/timeouts.
- Channel-created sessions pick the highest-priority agent instead of a hardcoded default.

### Changed

- Interrupt handling hardened; merge-answer queueing; sibling status and report limits; `max_queue_size` default raised 3 → 256.

## [0.1.3] - 2026-06-17

Interim release; see [0.1.2] and [0.1.4] for the surrounding feature set.

## [0.1.2] - 2026-06-16

### Added

- Prometheus `/api/metrics` endpoint.
- `observer` access level (global read-only).
- `halo upgrade` to bump the npm install in place.
- ESLint baseline for server, extended to cli and admin, wired into CI.

### Fixed

- Model registry loads lazily, fixing a new-provider startup race.
- Repeated-tool-call warning fires once per pattern instead of on every repeat.
- `glob`/`grep` no longer follow symlinks into infinite recursion.
- `view_image` sniffs media type from bytes instead of file extension.
- Disabled agents blocked from delegation, query, and cron.

### Changed

- Live agent roster injected into root prompts, replacing the static `ORCHESTRATION.md`.

## [0.1.1] - 2026-06-13

### Added

- Halo City: isometric pixel-art runtime visualizer + `/api/show/state` (replacing halo-show).
- `self.voice()` — play synthesized speech, with the face riding its live amplitude.
- Object-style command routing (`/agent`, `/skill`, `/session`, `/ws`, `/acp`, `/cron`) with noun-verb verbs and per-verb access control.
- ACP: Claude Code and Kiro binding kinds, direct-ask verbs.
- Desktop: build version stamp (`<version>-<sha>`) injected into the packaged server.

### Fixed

- Cron blocks same-job re-fire while a previous run is in-flight.
- Sub-session log entries lazy-init to stop sub-events leaking into the root file.
- WS/terminal tolerates 2 missed pongs, re-logs in on auth expiry, resyncs bracketed paste.
- Sandbox probes `bwrap` with a real namespaced run instead of `--version`.

## [0.1.0] - 2026-06-07

Initial public release.

### Added

- Multi-agent workspace: primary agent + sub-agent delegation, `.halo/` as the persisted knowledge/skill/session store.
- Channels: Admin (WebSocket), Web (HTTP+SSE), Telegram, Slack, Feishu, WeChat, CLI/TUI, ACP adapter.
- Self-evolution (`/evo`): drafts prompt-file patches, sandbox dry-run, scoring, admin review/apply.
- Cron tasks: scheduled agent runs with channel fan-out.
- Bubblewrap sandbox with `full` / `workspace` / `readonly` access levels.
- "Express Self" particle face driven by runtime `<<<SHOW>>>` markers.

[Unreleased]: https://github.com/turmind/halo-agent/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/turmind/halo-agent/compare/v0.2.6...v1.0.0
[0.2.6]: https://github.com/turmind/halo-agent/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/turmind/halo-agent/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/turmind/halo-agent/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/turmind/halo-agent/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/turmind/halo-agent/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/turmind/halo-agent/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/turmind/halo-agent/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/turmind/halo-agent/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/turmind/halo-agent/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/turmind/halo-agent/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/turmind/halo-agent/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/turmind/halo-agent/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/turmind/halo-agent/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/turmind/halo-agent/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/turmind/halo-agent/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/turmind/halo-agent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/turmind/halo-agent/releases/tag/v0.1.0
