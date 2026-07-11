// The instance's overwrite/ folder holds runtime outputs a purge sweeps out of
// Data/ (F4SE logs, MCM INI writes) — files with no owning mod. This surfaces
// that folder in the Loadout tree (issue #82). Pure, no vscode import: the
// TreeDataProvider consumes the count; the reveal/watch wiring lives in vscode-
// aware modules.

import { listRelativeFiles } from './deployer';

/** Recursive count of files under the overwrite folder (empty subdirectories
 *  don't count). Returns 0 when the folder is absent — it isn't created until
 *  the first purge deposits a stray file. Reuses the deployer's walk so the two
 *  "what's in this tree" traversals can't drift apart. */
export async function countOverwriteFiles(dir: string): Promise<number> {
  try {
    return (await listRelativeFiles(dir)).length;
  } catch {
    return 0; // absent folder → nothing to surface
  }
}
