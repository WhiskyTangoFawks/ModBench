// The overwrite/ folder holds runtime outputs a purge sweeps out of Data/ — files with no
// owning mod. No vscode import: the reveal and watch wiring live in vscode-aware modules.

import { listRelativeFiles } from './deployer';

/** Returns 0 when the folder is absent — it isn't created until a purge first deposits a
 *  stray file. Reuses the deployer's walk so the two traversals cannot diverge. */
export async function countOverwriteFiles(dir: string): Promise<number> {
  try {
    return (await listRelativeFiles(dir)).length;
  } catch {
    return 0; // absent folder → nothing to surface
  }
}
