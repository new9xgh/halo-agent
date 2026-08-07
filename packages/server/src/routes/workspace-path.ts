import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Shared (projectId, path) → filesystem resolution for /api routes that read
 * files on behalf of the admin. Currently imported by files.ts and
 * data-preview.ts; git.ts still carries a private copy of the same two
 * helpers (its resolveProjectPath is embedded in a differently-shaped getGit
 * flow) — migrating it here is a follow-up, so until then a traversal fix
 * must land in both places.
 */

/** projectId is an absolute workspace path (admin contract). Null when missing. */
export async function resolveProjectPath(projectId: string): Promise<string | null> {
  if (path.isAbsolute(projectId)) {
    try {
      await fs.access(projectId)
      return projectId
    } catch {
      return null
    }
  }
  return null
}

// Validate that a resolved path is within the project workspace (prevent traversal).
// Match on a path-segment boundary, not a raw string prefix — otherwise a sibling
// dir whose name starts with the project name (e.g. `myapp-secret` vs `myapp`)
// passes startsWith and escapes the sandbox.
export function validatePath(filePath: string, projectPath: string): boolean {
  const resolved = path.resolve(projectPath, filePath)
  const proj = path.resolve(projectPath)
  return resolved === proj || resolved.startsWith(proj + path.sep)
}

/**
 * Single-segment id guard for :params / body ids that get joined into
 * filesystem paths (agent ids, skill ids, session ids). Hono URL-decodes
 * `%2F` / `%2e` into route params, so "a URL segment can't contain /"
 * does NOT hold — `/agent-configs/..%2F..%2Fetc` reaches `path.join` as
 * `../../etc` and escapes the base directory (traversal read/write/rm).
 *
 * The whitelist is the union of every real id charset:
 *   - agent / skill ids: name slug `[a-z0-9\u4e00-\u9fff-]` (CJK names
 *     allowed — see the slug rule in agent-configs.ts POST) plus
 *     `__internal__` platform agents
 *   - session ids: `sid_…`, `s-…`, `web_<hex>_…`, `tg_<n>_…`, `wx_…`,
 *     `cron-<id>`, `agentcore_…`, and slack/feishu thread ids which embed
 *     `:` and `.` (`slack_C123:1699.123_x`); `>` is the hierarchical-id
 *     separator (session files are leaf-named, but a full id is still a
 *     harmless literal filename char on POSIX)
 *
 * `.` / `..` are rejected explicitly (path navigation); any other dotted
 * name (`a..b`) is a literal single segment and cannot traverse.
 */
export function isSafeIdSegment(id: string): boolean {
  if (id === '.' || id === '..') return false
  return /^[\w.:>\u4e00-\u9fff-]+$/.test(id)
}
