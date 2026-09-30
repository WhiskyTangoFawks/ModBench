import { downloadSidecarFile } from './layout';
import { exists, putIfChanged, removeStaleTempsFor, withLock } from './files';
import type { MoveToTrash } from '../ports/trash';

/** The one splice of a downloaded file's `.meta`, written whole only when `edit` changed it. A
 *  file with no `.meta` gets one, as MO2's QSettings creates it on first write. */
export function spliceDownloadMeta(
  downloadsDir: string, name: string, edit: (text: string) => string,
): Promise<{ wrote: boolean }> {
  return putIfChanged(downloadSidecarFile(downloadsDir, name), edit, { ifMissing: '' });
}

/** Moves a downloaded file's `.meta` to the trash, and removes a write of it a crash left behind;
 *  false when it has none. Under the `.meta`'s own lock, so no write in flight loses its temp. */
export function trashDownloadMeta(downloadsDir: string, name: string, trash: MoveToTrash): Promise<boolean> {
  const sidecar = downloadSidecarFile(downloadsDir, name);
  return withLock(sidecar, async () => {
    await removeStaleTempsFor(sidecar);
    if (!(await exists(sidecar))) return false;
    await trash(sidecar);
    return true;
  });
}
