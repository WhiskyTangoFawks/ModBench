// `.meta` sidecar gestures (ADR-0015 invariant 2): a free function per gesture taking the
// instance root and the download's filename, returning applied or a refusal. Each writes and
// returns — the downloads watcher is how the change comes back.

import { access, readFile, writeFile } from 'node:fs/promises';
import { setHiddenInText, setInstalledInText, setUninstalledInText } from '../mo2/downloads';
import { downloadFile, downloadSidecarFile } from '../mo2/layout';
import { createWriteQueue } from './writeQueue';

/** Every verb here writes unconditionally — a splice of the sidecar, or a trash — so `applied`
 *  carries no `wrote` flag of its own (ADR-0014 invariant 4). */
export type DownloadCommandResult =
  | { applied: true }
  | { applied: false; refusal: string };

/** Moves one file to the system trash. Injected because the trash belongs to the host, and this
 *  box holds no host types. */
export type TrashFile = (path: string) => Promise<void>;

const refuse = (err: unknown): DownloadCommandResult => ({
  applied: false,
  refusal: err instanceof Error ? err.message : String(err),
});

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

// Keyed by sidecar path: hide and mark-installed read-modify-write the same file, and an
// overlapping pair would each splice text the other had already read.
const sidecarWrites = createWriteQueue();

// The splice itself, already holding the lock on `path` — a verb with a precondition runs the
// two as one critical section.
async function spliceHeldSidecar(path: string, transform: (text: string) => string): Promise<DownloadCommandResult> {
  try {
    let before = '';
    try {
      before = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await writeFile(path, transform(before), 'utf8');
    return { applied: true };
  } catch (err) {
    return refuse(err);
  }
}

// The one splice point every sidecar verb goes through. An absent sidecar splices empty text
// rather than refusing: a manually-dropped archive has none, and MO2's QSettings creates one on
// first write.
function spliceSidecar(
  instanceRoot: string, name: string, transform: (text: string) => string,
): Promise<DownloadCommandResult> {
  const path = downloadSidecarFile(instanceRoot, name);
  return sidecarWrites(path, () => spliceHeldSidecar(path, transform));
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

/** Fired with the download the uninstalled mod's row names. A mod outlives its download, so an
 *  archive that is gone is a refusal: a sidecar beside no archive is one MO2 never writes. */
export function markDownloadUninstalled(instanceRoot: string, name: string): Promise<DownloadCommandResult> {
  const path = downloadSidecarFile(instanceRoot, name);
  // The check and the write are one task on the sidecar's queue, so nothing this queue
  // serializes can land between deciding to write and writing.
  return sidecarWrites(path, async () => {
    if (!(await exists(downloadFile(instanceRoot, name)))) {
      return { applied: false, refusal: `No such download: ${name}` };
    }
    // `installed` is left standing, as MO2 leaves it: the codec resolves the keys' precedence.
    return spliceHeldSidecar(path, setUninstalledInText);
  });
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
