// A free function per gesture, applied or a refusal (ADR-0015 invariant 2). Each writes and
// returns — the downloads watcher is how it comes back.

import { parseDownloadMeta, setHiddenInText } from '../mo2Codecs/downloads';
import { downloadFile, downloadSidecarFile } from '../instanceAdapter/layout';
import { exists, putIfChanged } from '../instanceAdapter/files';
import { refuse } from '../ports/refuse';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the downloads watcher (ADR-0014 invariant 4). */
export type DownloadsCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

// The one selection loop every plural verb below shares: each name lands or refuses on its own.
async function selectionOutcomeOf(
  names: readonly string[], run: (name: string) => Promise<DownloadsCommandResult>,
): Promise<SelectionOutcome<string>> {
  const landed: string[] = [];
  const refused: ItemRefusal<string>[] = [];
  for (const name of names) {
    const outcome = await run(name);
    if (outcome.applied) landed.push(name);
    else refused.push({ item: name, reason: outcome.refusal });
  }
  return { landed, refused };
}

// The transform returns `text` untouched when `hidden` already matches, so `putIfChanged` sees no
// change and writes nothing — no `.meta` for a row already at rest. A missing archive is refused
// first, so a stale row never writes a lone `.meta`.
async function spliceHidden(instanceRoot: string, name: string, hidden: boolean): Promise<DownloadsCommandResult> {
  try {
    if (!(await exists(downloadFile(instanceRoot, name)))) {
      return { applied: false, refusal: `"${name}" is gone from disk.` };
    }
    const { wrote } = await putIfChanged(
      downloadSidecarFile(instanceRoot, name),
      (text) => (parseDownloadMeta(text).hidden === hidden ? text : setHiddenInText(text, hidden)),
      { ifMissing: '' },
    );
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** Excluded is MO2's `removed` key — a separate axis from Status, so this says nothing about
 *  whether the download was ever installed. */
export function excludeDownload(instanceRoot: string, name: string): Promise<DownloadsCommandResult> {
  return spliceHidden(instanceRoot, name, true);
}

export function includeDownload(instanceRoot: string, name: string): Promise<DownloadsCommandResult> {
  return spliceHidden(instanceRoot, name, false);
}

export function excludeDownloads(instanceRoot: string, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => excludeDownload(instanceRoot, name));
}

export function includeDownloads(instanceRoot: string, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => includeDownload(instanceRoot, name));
}

/** Never touches the mod installed from any of them. */
export function deleteDownloads(
  instanceRoot: string, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => deleteDownload(instanceRoot, name, trash));
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
  return { applied: true, wrote: true };
}
