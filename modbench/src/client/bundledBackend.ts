import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { SpawnFn } from './backendLifecycle';

/** The self-contained backend the extension ships beside its bundle (see build:backend and
 *  .vscodeignore). */
export function bundledBackendPath(platform: NodeJS.Platform, bundleDir: string): string {
  const exe = platform === 'win32' ? 'MEditService.Http.exe' : 'MEditService.Http';
  return path.join(bundleDir, '..', 'backend', exe);
}

// The stdin pipe is never written. The OS closes it when this extension host dies, however it dies,
// and the backend exits on its end, so no backend outlives the window that spawned it.
export const spawnPiped: SpawnFn = (exe, args) =>
  spawn(exe, [...args, '--ExitWhenStdinCloses', 'true'], { detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
