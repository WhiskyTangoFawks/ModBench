// The download sidecar, which install owns: a free function per gesture, applied or a refusal
// (ADR-0015 invariant 2). Each writes and returns — the downloads watcher is how it comes back.

import { setHiddenInText, setInstalledInText } from '../mo2Codecs/downloads';
import { downloadFile, downloadSidecarFile } from '../mo2Files/layout';
import { exists, put } from '../mo2Files/files';
import { refuse } from '../ports/refuse';

/** Every verb here writes unconditionally — a splice of the sidecar, or a trash — so `applied`
 *  carries no `wrote` flag of its own (ADR-0014 invariant 4). */
export type DownloadCommandResult =
  | { applied: true }
  | { applied: false; refusal: string };

/** Moves one file to the system trash. Injected because the trash belongs to the host, and this
 *  box holds no host types. */
export type TrashFile = (path: string) => Promise<void>;

// The one splice point every sidecar verb goes through. An absent sidecar splices empty text
// rather than refusing: a manually-dropped archive has none, and MO2's QSettings creates one on
// first write.
async function spliceSidecar(
  instanceRoot: string, name: string, transform: (text: string) => string,
): Promise<DownloadCommandResult> {
  try {
    await put(downloadSidecarFile(instanceRoot, name), transform, { ifMissing: '' });
    return { applied: true };
  } catch (err) {
    return refuse(err);
  }
}

/** Hidden is MO2's `removed` key — a separate axis from Status, so this says nothing about
 *  whether the download was ever installed. */
export function hideDownload(instanceRoot: string, name: string): Promise<DownloadCommandResult> {
  return spliceSidecar(instanceRoot, name, (text) => setHiddenInText(text, true));
}

export function unhideDownload(instanceRoot: string, name: string): Promise<DownloadCommandResult> {
  return spliceSidecar(instanceRoot, name, (text) => setHiddenInText(text, false));
}

/** The bookkeeping half of an install: the mod folder is the install command's own business, and
 *  this writes only the key MO2's Downloads tab reads. */
export function markDownloadInstalled(instanceRoot: string, name: string): Promise<DownloadCommandResult> {
  return spliceSidecar(instanceRoot, name, setInstalledInText);
}

/** The sidecar is trashed BEFORE the archive, so a mid-failure leaves a metaless archive — an
 *  ordinary Downloaded row — never a lone sidecar. Never touches the mod installed from it. */
export async function deleteDownload(
  instanceRoot: string, name: string, trash: TrashFile,
): Promise<DownloadCommandResult> {
  const sidecar = downloadSidecarFile(instanceRoot, name);
  try {
    if (await exists(sidecar)) await trash(sidecar);
    await trash(downloadFile(instanceRoot, name));
  } catch (err) {
    return refuse(err);
  }
  return { applied: true };
}
