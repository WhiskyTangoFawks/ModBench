// A free function per gesture, applied or a refusal (ADR-0015 invariant 2). Each writes and
// returns — the downloads watcher is how it comes back.

import { parseDownloadMeta, setHiddenInText } from '../mo2Codecs/downloads';
import { downloadFile } from '../instanceAdapter/layout';
import { exists } from '../instanceAdapter/files';
import { spliceDownloadMeta, trashDownloadMeta } from '../instanceAdapter/downloadMeta';
import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';

/** `wrote` is false when the gesture already held, so no watcher fires (ADR-0014 invariant 4).
 *  `metaLeftBehind` is delete's own: the file trashed but its `.meta` didn't. */
export type DownloadsCommandResult =
  | { applied: true; wrote: boolean; metaLeftBehind?: string }
  | { applied: false; refusal: string };

// The one selection loop every plural verb shares. `toItem` builds the item a caller sees, so
// delete's can carry a per-landed note while exclude and include's stays the bare name.
async function selectionOutcomeOf<T>(
  names: readonly string[],
  run: (name: string) => Promise<DownloadsCommandResult>,
  toItem: (name: string, metaLeftBehind?: string) => T,
): Promise<SelectionOutcome<T>> {
  const landed: T[] = [];
  const refused: ItemRefusal<T>[] = [];
  for (const name of names) {
    const outcome = await run(name);
    if (outcome.applied) landed.push(toItem(name, outcome.metaLeftBehind));
    else refused.push({ item: toItem(name), reason: outcome.refusal });
  }
  return { landed, refused };
}

// The transform returns `text` untouched when `excluded` already matches, so the splice writes
// nothing — no `.meta` for a row already at rest. A missing archive is refused first, so a stale
// row never writes a lone `.meta`.
async function spliceExcluded(downloadsDir: string, name: string, excluded: boolean): Promise<DownloadsCommandResult> {
  try {
    if (!(await exists(downloadFile(downloadsDir, name)))) {
      return { applied: false, refusal: `"${name}" is gone from disk.` };
    }
    const { wrote } = await spliceDownloadMeta(
      downloadsDir, name,
      (text) => (parseDownloadMeta(text).excluded === excluded ? text : setHiddenInText(text, excluded)),
    );
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** Excluded is MO2's `removed` key — a separate axis from Status, so this says nothing about
 *  whether the download was ever installed. */
export function excludeDownload(downloadsDir: string, name: string): Promise<DownloadsCommandResult> {
  return spliceExcluded(downloadsDir, name, true);
}

export function includeDownload(downloadsDir: string, name: string): Promise<DownloadsCommandResult> {
  return spliceExcluded(downloadsDir, name, false);
}

const bareName = (name: string): string => name;

export function excludeDownloads(downloadsDir: string, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => excludeDownload(downloadsDir, name), bareName);
}

export function includeDownloads(downloadsDir: string, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => includeDownload(downloadsDir, name), bareName);
}

/** A landed delete: `metaLeftBehind` is set only when the file's own trash landed but its
 *  `.meta`'s then failed — the delete still applied, so a caller logs this, not a refusal. */
export interface DeletedDownload {
  name: string;
  metaLeftBehind?: string;
}

const toDeletedDownload = (name: string, metaLeftBehind?: string): DeletedDownload =>
  metaLeftBehind === undefined ? { name } : { name, metaLeftBehind };

/** Never touches the mod installed from any of them. */
export function deleteDownloads(
  downloadsDir: string, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionOutcome<DeletedDownload>> {
  return selectionOutcomeOf(names, (name) => deleteDownload(downloadsDir, name, trash), toDeletedDownload);
}

// The file is trashed first, so a failure there refuses with the sidecar untouched. Past that
// point a `.meta` trash failure comes back as `metaLeftBehind` (downloads.md, Reporting story 2).
async function deleteDownload(
  downloadsDir: string, name: string, trash: MoveToTrash,
): Promise<DownloadsCommandResult> {
  try {
    await trash(downloadFile(downloadsDir, name));
  } catch (err) {
    return refuse(err);
  }
  try {
    await trashDownloadMeta(downloadsDir, name, trash);
  } catch (err) {
    return { applied: true, wrote: true, metaLeftBehind: errorMessage(err) };
  }
  return { applied: true, wrote: true };
}
