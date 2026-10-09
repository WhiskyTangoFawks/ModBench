// A free function per gesture, applied or a refusal (ADR-0014; ADR-0015).

import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import type { DownloadedFile, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { goneFromDisk } from '../coreLib/commandRefusals';
import type { TailOf } from '../coreLib/boundCommand';
import { selectionOutcomeOf, type CommandResult } from '../coreLib/commandResult';

// `metadataLeftBehind` is delete's own: the file trashed but its metadata didn't.
type DownloadsCommandResult = CommandResult<{ wrote: boolean; metadataLeftBehind?: string }>;

async function mark(adapter: InstanceAdapter, name: string, excluded: 'Excluded' | 'Included'): Promise<DownloadsCommandResult> {
  try {
    const marked = await adapter.markDownloadedFile(name, excluded);
    if (marked.gone) return { applied: false, refusal: goneFromDisk(name) };
    return { applied: true, wrote: marked.wrote };
  } catch (err) {
    return refuse(err);
  }
}

function excludeDownload(adapter: InstanceAdapter, name: string): Promise<DownloadsCommandResult> {
  return mark(adapter, name, 'Excluded');
}

function includeDownload(adapter: InstanceAdapter, name: string): Promise<DownloadsCommandResult> {
  return mark(adapter, name, 'Included');
}

const bareName = (name: string): string => name;

function excludeDownloads(adapter: InstanceAdapter, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => excludeDownload(adapter, name), bareName);
}

function includeDownloads(adapter: InstanceAdapter, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => includeDownload(adapter, name), bareName);
}

/** A downloaded file to delete: its name, and the path it is trashed from. */
export type DownloadToDelete = Pick<DownloadedFile, 'name' | 'path'>;

/** A landed delete: `metadataLeftBehind` is set only when the file's own trash landed but its
 *  metadata's then failed — the delete still applied, so a caller logs this, not a refusal. */
export interface DeletedDownload {
  name: string;
  metadataLeftBehind?: string;
}

const toDeletedDownload = ({ name }: DownloadToDelete, landed?: { metadataLeftBehind?: string }): DeletedDownload =>
  landed?.metadataLeftBehind === undefined ? { name } : { name, metadataLeftBehind: landed.metadataLeftBehind };

/** Never touches the mod installed from any of them. */
function deleteDownloads(
  adapter: InstanceAdapter, files: readonly DownloadToDelete[], trash: MoveToTrash,
): Promise<SelectionOutcome<DeletedDownload>> {
  return selectionOutcomeOf(files, (file) => deleteDownload(adapter, file, trash), toDeletedDownload);
}

// The file is trashed first, so a failure there refuses with the sidecar untouched. Past that
// point a metadata trash failure comes back as `metadataLeftBehind` (downloads.md, Reporting story 2).
async function deleteDownload(
  adapter: InstanceAdapter, file: DownloadToDelete, trash: MoveToTrash,
): Promise<DownloadsCommandResult> {
  try {
    await trash(file.path);
  } catch (err) {
    return refuse(err);
  }
  try {
    await adapter.trashDownloadedFileMeta(file.name, trash);
  } catch (err) {
    return { applied: true, wrote: true, metadataLeftBehind: errorMessage(err) };
  }
  return { applied: true, wrote: true };
}

/** The downloads' commands, bound to one instance: each takes the gesture's arguments only. */
export function downloadsCommands(adapter: InstanceAdapter) {
  return {
    excludeDownloads: (...args: TailOf<typeof excludeDownloads>) => excludeDownloads(adapter, ...args),
    includeDownloads: (...args: TailOf<typeof includeDownloads>) => includeDownloads(adapter, ...args),
    deleteDownloads: (...args: TailOf<typeof deleteDownloads>) => deleteDownloads(adapter, ...args),
  };
}

export type DownloadsCommands = ReturnType<typeof downloadsCommands>;
