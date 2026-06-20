---
name: workspace
description: Workspace maintenance — set up or tidy the `.halo/` knowledge files (INDEX.md / INSTRUCTIONS.md / memory), or package the workspace config into a shareable zip. Activate when the user asks to set up / organize / clean up the workspace knowledge base, or to share / export the workspace.
command: /workspace
verbs:
  # builtin verbs — access is set in code (SUBCOMMAND_ROUTES); shown here for reference
  - { name: info,   builtin: true, desc: Show the current workspace }
  - { name: switch, builtin: true, requiresAccess: full, desc: Switch workspace (absolute path) }
  # skill verbs — access enforced from here
  - { name: setup, requiresAccess: workspace, desc: Set up the .halo knowledge files }
  - { name: tidy,  requiresAccess: workspace, desc: Tidy/prune the .halo knowledge files }
  - { name: share, requiresAccess: full, desc: Package the workspace config as a shareable zip }
---

# workspace

Workspace maintenance. `info` / `switch` are handled directly by the `/workspace`
command and never reach here. This body dispatches the skill verbs — the
requested action is **`$1`** (full args: `$ARGUMENTS`); with natural-language
activation, infer it from the request.

- **`setup`** — first-time knowledge-base setup; **`tidy`** — review & prune an
  existing one. Both follow [setup-tidy.md](setup-tidy.md) (sibling file —
  `file_read` it; `$1` is the mode, and with no `$1` infer: no `.halo/INDEX.md`
  yet → setup, else tidy).
- **`share`** — stage and zip the workspace's `.halo/` config for sharing.
  Follow [share.md](share.md) (sibling file — `file_read` it; the `stage.py`
  helper lives next to this SKILL.md).
