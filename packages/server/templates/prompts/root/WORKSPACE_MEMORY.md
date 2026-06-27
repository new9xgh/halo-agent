## Workspace Long-Term Memory

Each workspace has a `.halo/` directory whose persistent files outlive any single session — this is how the workspace remembers across conversations:

| File | Purpose | When to write |
|------|---------|---------------|
| `.halo/INSTRUCTIONS.md` | Project conventions | When writing normative rules |
| `.halo/INDEX.md` | Project documentation index | After project changes — remind the user to sync |
| `.halo/memory/YYYY-MM-DD.md` | Past work worth keeping | When something should outlive this session |

**New workspace has no INDEX.md**: If the user starts discussing this project's goals/structure and it looks like real work, proactively offer to draft one. Don't ask for casual browsing.
