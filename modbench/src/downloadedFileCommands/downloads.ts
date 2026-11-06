// A free function per gesture, applied or a refusal (ADR-0014; ADR-0015).

import { refuse } from '../coreLib/refuse';
import type { SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { isInstallationFileName, type InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { goneFromDisk } from '../coreLib/commandRefusals';
import type { TailOf } from '../coreLib/boundCommand';
import { selectionOutcomeOf, type CommandResult } from '../coreLib/commandResult';
import { change, committedBy, type RenameEditing } from '../coreLib/change';
import { manifestDownloadedFileReferences } from '../manifestAdapter/manifestAdapter';
import type { ChangeResult } from '../ports/changeResult';

type DownloadedFileCommandResult = CommandResult<{ wrote: boolean; metadataLeftBehind?: string }>;

async function mark(adapter: InstanceAdapter, name: string, excluded: 'Excluded' | 'Included'): Promise<DownloadedFileCommandResult> {
  try {
    const marked = await adapter.markDownloadedFile(name, excluded);
    if (marked.gone) return { applied: false, refusal: goneFromDisk(name) };
    return { applied: true, wrote: marked.wrote };
  } catch (err) {
    return refuse(err);
  }
}

function excludeDownloadedFile(adapter: InstanceAdapter, name: string): Promise<DownloadedFileCommandResult> {
  return mark(adapter, name, 'Excluded');
}

function includeDownloadedFile(adapter: InstanceAdapter, name: string): Promise<DownloadedFileCommandResult> {
  return mark(adapter, name, 'Included');
}

const bareName = (name: string): string => name;

function excludeDownloadedFiles(adapter: InstanceAdapter, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => excludeDownloadedFile(adapter, name), bareName);
}

function includeDownloadedFiles(adapter: InstanceAdapter, names: readonly string[]): Promise<SelectionOutcome<string>> {
  return selectionOutcomeOf(names, (name) => includeDownloadedFile(adapter, name), bareName);
}

export interface DeletedDownloadedFile {
  name: string;
  metadataLeftBehind?: string;
}

const leftBehind = (reason?: string): { metadataLeftBehind?: string } => (reason === undefined ? {} : { metadataLeftBehind: reason });

const toDeletedDownloadedFile = (name: string, landed?: { metadataLeftBehind?: string }): DeletedDownloadedFile =>
  ({ name, ...leftBehind(landed?.metadataLeftBehind) });

// Never touches the mod installed from any of them.
function deleteDownloadedFiles(
  adapter: InstanceAdapter, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionOutcome<DeletedDownloadedFile>> {
  return selectionOutcomeOf(names, (name) => deleteDownloadedFile(adapter, name, trash), toDeletedDownloadedFile);
}

async function deleteDownloadedFile(adapter: InstanceAdapter, name: string, trash: MoveToTrash): Promise<DownloadedFileCommandResult> {
  try {
    const trashed = await adapter.trashDownloadedFile(name, trash);
    if (trashed.gone) return { applied: false, refusal: goneFromDisk(name) };
    return { applied: true, wrote: true, ...leftBehind(trashed.metadataLeftBehind) };
  } catch (err) {
    return refuse(err);
  }
}

// commands.md, `modbench.symbol.followRename`: the file and its metadata, each manifest's installation file package and
// each mod's metadata. Install owns which names are downloaded files.
async function renameDownloadedFile(adapter: InstanceAdapter, { held, apply }: RenameEditing, from: string, to: string): Promise<ChangeResult> {
  if (!isInstallationFileName(to)) return { applied: false, refusal: `Not a file install can take: "${to}"` };
  let modFolders: string[];
  try {
    modFolders = ((await adapter.modOrder()).modFolders ?? []).flatMap(({ kind, path }) => (kind === 'mod' ? [path] : []));
  } catch (err) {
    return refuse(err);
  }
  const owners = { definition: committedBy(() => adapter.renameDownloadedFile(from, to)), references: [manifestDownloadedFileReferences(modFolders)] };
  return change(owners, (owner) => owner.plan({ kind: 'downloadedFile', name: from }, to, held), apply);
}

/** The downloads' commands, bound to one instance: each takes the gesture's arguments only. */
export function downloadedFileCommands(adapter: InstanceAdapter) {
  return {
    excludeDownloadedFiles: (...args: TailOf<typeof excludeDownloadedFiles>) => excludeDownloadedFiles(adapter, ...args),
    includeDownloadedFiles: (...args: TailOf<typeof includeDownloadedFiles>) => includeDownloadedFiles(adapter, ...args),
    deleteDownloadedFiles: (...args: TailOf<typeof deleteDownloadedFiles>) => deleteDownloadedFiles(adapter, ...args),
    renameDownloadedFile: (...args: TailOf<typeof renameDownloadedFile>) => renameDownloadedFile(adapter, ...args),
  };
}

export type DownloadedFileCommands = ReturnType<typeof downloadedFileCommands>;
