import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { SpawnFn } from './backendLifecycle';

/** The self-contained backend the extension ships beside its bundle (see build:backend and
 *  .vscodeignore). */
export function bundledBackendPath(platform: NodeJS.Platform, bundleDir: string): string {
  const exe = platform === 'win32' ? 'MEditService.Http.exe' : 'MEditService.Http';
  return path.join(bundleDir, '..', 'backend', exe);
}

export const spawnPiped: SpawnFn = (exe, args) => spawn(exe, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
