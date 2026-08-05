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
