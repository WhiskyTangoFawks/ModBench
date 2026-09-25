import { downloadFile, downloadSidecarFile } from './layout';
import { exists, putIfChanged } from './files';
import type { MoveToTrash } from '../ports/trash';

/** The one splice of a downloaded file's `.meta`, written whole only when `edit` changed it. A
 *  file with no `.meta` gets one, as MO2's QSettings creates it on first write. */
export function spliceDownloadMeta(
  downloadsDir: string, name: string, edit: (text: string) => string,
): Promise<{ wrote: boolean }> {
  return putIfChanged(downloadSidecarFile(downloadsDir, name), edit, { ifMissing: '' });
}

/** A downloaded file's own path, and its `.meta`'s beside it: what a row opens. */
export function downloadPaths(downloadsDir: string, name: string): { path: string; sidecarPath: string } {
  return { path: downloadFile(downloadsDir, name), sidecarPath: downloadSidecarFile(downloadsDir, name) };
}

/** Moves a downloaded file's `.meta` to the trash; false when it has none. */
export async function trashDownloadMeta(downloadsDir: string, name: string, trash: MoveToTrash): Promise<boolean> {
  const sidecar = downloadSidecarFile(downloadsDir, name);
  if (!(await exists(sidecar))) return false;
  await trash(sidecar);
  return true;
}
