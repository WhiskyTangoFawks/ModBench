import { setInstalledInText } from '../mo2Codecs/downloads';
import { downloadSidecarFile } from '../instanceAdapter/layout';
import { put } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';

export type InstalledMarkResult =
  | { applied: true }
  | { applied: false; refusal: string };

/** Writes only the key MO2's Downloads tab reads. A manually-dropped archive has no sidecar, and
 *  MO2's QSettings creates one on first write, so an absent one splices empty text. */
export async function markDownloadInstalled(instanceRoot: string, name: string): Promise<InstalledMarkResult> {
  try {
    await put(downloadSidecarFile(instanceRoot, name), setInstalledInText, { ifMissing: '' });
    return { applied: true };
  } catch (err) {
    return refuse(err);
  }
}
