import { downloadSidecarFile } from './layout';
import { putIfChanged } from './files';

/** The one splice of a downloaded file's `.meta`, written whole only when `edit` changed it. A
 *  file with no `.meta` gets one, as MO2's QSettings creates it on first write. */
export function spliceDownloadMeta(
  downloadsDir: string, name: string, edit: (text: string) => string,
): Promise<{ wrote: boolean }> {
  return putIfChanged(downloadSidecarFile(downloadsDir, name), edit, { ifMissing: '' });
}
