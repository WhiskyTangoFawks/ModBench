// The overwrite/ folder holds runtime outputs — files with no owning mod. No vscode import:
// the reveal and watch wiring live in vscode-aware modules.

import { listRelativeFiles } from '../instanceAdapter/files';
import { errnoCode } from '../ports/errno';

/** Returns 0 when the folder is absent. Reuses the Instance adapter's walk so the two traversals
 *  cannot diverge. */
export async function countOverwriteFiles(dir: string): Promise<number> {
  try {
    return (await listRelativeFiles(dir)).length;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 0;
    throw err;
  }
}
