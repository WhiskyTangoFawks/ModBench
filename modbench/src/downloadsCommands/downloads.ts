// A free function per gesture, applied or a refusal (ADR-0015 invariant 2). Each writes and
// returns — the downloads watcher is how it comes back.

import { setHiddenInText } from '../mo2Codecs/downloads';
import { downloadFile, downloadSidecarFile } from '../instanceAdapter/layout';
import { exists, put } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';

/** Every verb here writes unconditionally — a splice of the sidecar, or a trash — so `applied`
 *  carries no `wrote` flag of its own (ADR-0014 invariant 4). */
export type DownloadsCommandResult =
  | { applied: true }
  | { applied: false; refusal: string };

// The one splice point every sidecar verb goes through. An absent sidecar splices empty text
// rather than refusing: a manually-dropped archive has none, and MO2's QSettings creates one on
// first write.
async function spliceSidecar(
  instanceRoot: string, name: string, transform: (text: string) => string,
): Promise<DownloadsCommandResult> {
  try {
    await put(downloadSidecarFile(instanceRoot, name), transform, { ifMissing: '' });
    return { applied: true };
  } catch (err) {
    return refuse(err);
  }
}

/** Excluded is MO2's `removed` key — a separate axis from Status, so this says nothing about
 *  whether the download was ever installed. */
export function excludeDownload(instanceRoot: string, name: string): Promise<DownloadsCommandResult> {
  return spliceSidecar(instanceRoot, name, (text) => setHiddenInText(text, true));
}

export function includeDownload(instanceRoot: string, name: string): Promise<DownloadsCommandResult> {
  return spliceSidecar(instanceRoot, name, (text) => setHiddenInText(text, false));
}

/** Never touches the mod installed from any of them. */
export async function deleteDownloads(
  instanceRoot: string, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionOutcome<string>> {
  const landed: string[] = [];
  const refused: ItemRefusal<string>[] = [];
  for (const name of names) {
    const outcome = await deleteDownload(instanceRoot, name, trash);
    if (outcome.applied) landed.push(name);
    else refused.push({ item: name, reason: outcome.refusal });
  }
  return { landed, refused };
}

// The sidecar is trashed BEFORE the archive, so a mid-failure leaves a metaless archive — an
// ordinary Downloaded row — never a lone sidecar.
async function deleteDownload(
  instanceRoot: string, name: string, trash: MoveToTrash,
): Promise<DownloadsCommandResult> {
  const sidecar = downloadSidecarFile(instanceRoot, name);
  try {
    if (await exists(sidecar)) await trash(sidecar);
    await trash(downloadFile(instanceRoot, name));
  } catch (err) {
    return refuse(err);
  }
  return { applied: true };
}
