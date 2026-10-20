import { downloadedFileMetadataPath } from './layout';
import { exists, putIfChanged, removeStaleTempsFor, withLock } from '../files';
import type { MoveToTrash } from '../../ports/trash';

/** The one splice of a downloaded file's `.meta`, written whole only when `edit` changed it. A
 *  file with no `.meta` gets one, as MO2's QSettings creates it on first write. */
export function spliceDownloadedFileMeta(
  downloadsDir: string, name: string, edit: (text: string) => string,
): Promise<{ wrote: boolean }> {
  return putIfChanged(downloadedFileMetadataPath(downloadsDir, name), edit, { ifMissing: '' });
}

/** Moves a downloaded file's `.meta` to the trash, and removes a write of it a crash left behind;
 *  false when it has none. Under the `.meta`'s own lock, so no write in flight loses its temp. */
export function trashDownloadedFileMeta(downloadsDir: string, name: string, trash: MoveToTrash): Promise<boolean> {
  const metadata = downloadedFileMetadataPath(downloadsDir, name);
  return withLock(metadata, async () => {
    await removeStaleTempsFor(metadata);
    if (!(await exists(metadata))) return false;
    await trash(metadata);
    return true;
  });
}
