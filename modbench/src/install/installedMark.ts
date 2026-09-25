import { setInstalledInText } from '../mo2Codecs/downloads';
import { spliceDownloadMeta } from '../instanceAdapter/downloadMeta';
import { refuse } from '../ports/refuse';

export type InstalledMarkResult =
  | { applied: true }
  | { applied: false; refusal: string };

/** Writes only the key MO2's Downloads tab reads. */
export async function markDownloadInstalled(downloadsDir: string, name: string): Promise<InstalledMarkResult> {
  try {
    await spliceDownloadMeta(downloadsDir, name, setInstalledInText);
    return { applied: true };
  } catch (err) {
    return refuse(err);
  }
}
