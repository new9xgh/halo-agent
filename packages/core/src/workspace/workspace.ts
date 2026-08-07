import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, sep } from 'node:path';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class Workspace {
  constructor(public projectRoot: string) {}

  async readFile(path: string): Promise<string> {
    const fullPath = this.validatePath(path);
    return readFile(fullPath, 'utf-8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = this.validatePath(path);
    const dir = resolve(fullPath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  validatePath(path: string): string {
    const fullPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path);

    // Root cause: a raw startsWith prefix check passes for a SIBLING directory
    // whose name merely starts with the project name (`/x/myapp-secret` vs
    // `/x/myapp`) — match on a path-segment boundary instead, same as
    // routes/files.ts's validatePath.
    const root = resolve(this.projectRoot);
    if (fullPath !== root && !fullPath.startsWith(root + sep)) {
      throw new WorkspaceError(
        `Path "${path}" is outside the workspace directory "${this.projectRoot}"`,
      );
    }

    // The lexical check above doesn't follow symlinks — a link inside the
    // workspace pointing outside (ws/escape -> /etc) passes startsWith yet
    // reads out of bounds. Resolve symlinks and re-check against the
    // realpath'd root (same pattern as server's assertPathAllowed).
    // realpathSync resolves Windows junctions/symlinks too.
    try {
      const real = realpathSync(fullPath);
      const realRoot = realpathSync(root);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new WorkspaceError(
          `Path "${path}" is outside the workspace directory "${this.projectRoot}"`,
        );
      }
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // ENOENT etc. — target doesn't exist yet (new-file case); no symlink
      // to follow, the lexical check above is sufficient.
    }

    return fullPath;
  }
}
