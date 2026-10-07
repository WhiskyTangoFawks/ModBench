// A free function per gesture, applied or a refusal (ADR-0014; ADR-0015).

import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { goneFromDisk, type DownloadedFile, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';

/** What a downloads command reaches the instance through. */
export interface DownloadsAccess {
  readonly adapter: InstanceAdapter;
}

// `wrote` is false when the gesture already held (commands.md, Doing nothing is not an error),
// so no watcher fires.
// `metadataLeftBehind` is delete's own: the file trashed but its metadata didn't.
type DownloadsCommandResult =
  | { applied: true; wrote: boolean; metadataLeftBehind?: string }
  | { applied: false; refusal: string };

// The one selection loop every plural verb shares. `toItem` builds the item a caller sees, so
// delete's can carry a per-landed note while exclude and include's stays the bare name.
async function selectionOutcomeOf<I, T>(
  items: readonly I[],
  run: (item: I) => Promise<DownloadsCommandResult>,
  toItem: (item: I, metadataLeftBehind?: string) => T,
): Promise<SelectionOutcome<T>> {
  const landed: T[] = [];
  const refused: ItemRefusal<T>[] = [];
  for (const item of items) {
    const outcome = await run(item);
    if (outcome.applied) landed.push(toItem(item, outcome.metadataLeftBehind));
    else refused.push({ item: toItem(item), reason: outcome.refusal });
  }
  return { landed, refused };
}

async function mark(access: DownloadsAccess, name: string, excluded: 'Excluded' | 'Included'): Promise<DownloadsCommandResult> {
  try {
    const marked = await access.adapter.markDownloadedFile(name, excluded);
    if (marked.gone) return { applied: false, refusal: goneFromDisk(name) };
    return { applied: true, wrote: marked.wrote };
  } catch (err) {
    return refuse(err);
  }
}

function excludeDownload(access: DownloadsAccess, name: string): Promise<DownloadsCommandResult> {
  return mark(access, name, 'Excluded');
}

function includeDownload(access: DownloadsAccess, name: string): Promise<DownloadsCommandResult> {
  return mark(access, name, 'Included');
}

const bareName = (name: string): string => name;

export function excludeDownloads(access: DownloadsAccess, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => excludeDownload(access, name), bareName);
}

export function includeDownloads(access: DownloadsAccess, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => includeDownload(access, name), bareName);
}

/** A downloaded file to delete: its name, and the path it is trashed from. */
export type DownloadToDelete = Pick<DownloadedFile, 'name' | 'path'>;

/** A landed delete: `metadataLeftBehind` is set only when the file's own trash landed but its
 *  metadata's then failed — the delete still applied, so a caller logs this, not a refusal. */
export interface DeletedDownload {
  name: string;
  metadataLeftBehind?: string;
}

const toDeletedDownload = ({ name }: DownloadToDelete, metadataLeftBehind?: string): DeletedDownload =>
  metadataLeftBehind === undefined ? { name } : { name, metadataLeftBehind };

/** Never touches the mod installed from any of them. */
export function deleteDownloads(
  access: DownloadsAccess, files: readonly DownloadToDelete[], trash: MoveToTrash,
): Promise<SelectionOutcome<DeletedDownload>> {
  return selectionOutcomeOf(files, (file) => deleteDownload(access, file, trash), toDeletedDownload);
}

// The file is trashed first, so a failure there refuses with the sidecar untouched. Past that
// point a metadata trash failure comes back as `metadataLeftBehind` (downloads.md, Reporting story 2).
async function deleteDownload(
  access: DownloadsAccess, file: DownloadToDelete, trash: MoveToTrash,
): Promise<DownloadsCommandResult> {
  try {
    await trash(file.path);
  } catch (err) {
    return refuse(err);
  }
  try {
    await access.adapter.trashDownloadedFileMeta(file.name, trash);
  } catch (err) {
    return { applied: true, wrote: true, metadataLeftBehind: errorMessage(err) };
  }
  return { applied: true, wrote: true };
}
