import * as vscode from 'vscode';
import type { DownloadedFileSortColumn } from './downloadedFileRows';
import type { DeletedDownloadedFile, DownloadedFileCommands } from '../downloadedFileCommands/downloads';
import type { DownloadsProvider, DownloadsTreeNode } from './DownloadsProvider';
import { DOWNLOADS_KEY_ARGS } from './keyContext';
import { pluralArgument, registerGesture, singularArgument } from '../drivingLib/gestureEntry';
import {
  argumentOfKind, registerAgentGesture, reportPartial, type AgentGesture, type GestureResult, type PartialFailure,
} from '../drivingLib/agentGesture';
import type { Argument } from '../wire/argument';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { reportFailure } from '../drivingLib/reportFailure';
import { runWritingGesture } from '../drivingLib/writingGesture';

const runDownloadsWriting = <T>(instance: Pick<Instance, 'refresh'>, command: () => Promise<T>): Promise<T> =>
  runWritingGesture(DOWNLOADS_KEY_ARGS.view, instance, command);
import type { Instance, InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { SelectionOutcome } from '../ports/selectionOutcome';

// One question for the whole selection: an N-file selection must not stack N modal dialogs.
async function confirmDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const [only] = names;
  const question = names.length === 1 && only !== undefined
    ? `Delete "${only}"? It will be moved to the system trash. The installed mod, if any, is untouched.`
    : `Delete ${names.length} items? They will be moved to the system trash. The installed mod, if any, is untouched.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

type DownloadsGesture<Given, Item> = AgentGesture<DownloadsTreeNode, Given, GestureResult<Item>>;

const downloadedFileNameOf = (argument: Argument): string => argumentOfKind(argument, 'downloadedFile').name;

const landed = async <Item>(outcome: Promise<SelectionOutcome<Item>>, partial?: (outcome: SelectionOutcome<Item>) => PartialFailure[]): Promise<GestureResult<Item>> => {
  const settled = await outcome;
  return { applied: true, outcome: settled, partial: partial?.(settled) ?? [] };
};

// Metadata left behind is not a failure (downloads.md, Reporting story 2): the delete already
// applied, so it is a log-severity partial, never a notification.
const deletedPartials = (managerNames: Pick<InstanceValue['managerNames'], 'downloadedFileMetadataFile'>) =>
  ({ landed }: SelectionOutcome<DeletedDownloadedFile>): PartialFailure[] =>
    landed.flatMap(({ name, metadataLeftBehind }) => (metadataLeftBehind === undefined ? [] : [{
      message: `"${name}" was deleted, but its ${managerNames.downloadedFileMetadataFile} could not be moved to the trash and was left behind`,
      detail: metadataLeftBehind, severity: 'log' as const,
    }]));

function deleteGesture(
  commands: DownloadedFileCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
  ask: AskQuestion, trash: MoveToTrash, log: (line: string) => void,
): DownloadsGesture<readonly string[], DeletedDownloadedFile> {
  return {
    fromView: async (entry) => {
      const names = pluralArgument(entry, 'downloadedFile').map((node) => node.argument.row.name);
      return names.length > 0 && await confirmDelete(names, ask) ? names : undefined;
    },
    fromAgent: ({ argument }) => argument.map(downloadedFileNameOf),
    run: (names) => runDownloadsWriting(instance, () =>
      landed(commands.deleteDownloadedFiles(names, trash), deletedPartials(instance.value.managerNames))),
    report: (result, names) => {
      if (!result.applied) return;
      reporter.selectionOutcome(
        `Could not delete ${result.outcome.refused.length} of ${names.length} downloaded files.`, result.outcome, (item) => item.name);
      reportPartial(reporter, result.partial, log);
    },
  };
}

function markGesture(
  commands: DownloadedFileCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, excluded: boolean,
): DownloadsGesture<readonly string[], string> {
  const verb = excluded ? 'exclude' : 'include';
  return {
    fromView: (entry) => {
      const names = pluralArgument(entry, 'downloadedFile').map((node) => node.argument.row.name);
      return names.length === 0 ? undefined : names;
    },
    fromAgent: ({ argument }) => argument.map(downloadedFileNameOf),
    run: (names) => runDownloadsWriting(instance, () =>
      landed(excluded ? commands.excludeDownloadedFiles(names) : commands.includeDownloadedFiles(names))),
    report: (result, names) => {
      if (!result.applied) return;
      reporter.selectionOutcome(`Could not ${verb} ${result.outcome.refused.length} of ${names.length} downloaded files.`, result.outcome, (name) => name);
    },
  };
}

/** Clicked row only, as five opened tabs help no one. The palette hands no row, so open and
 *  open metadata take the one selected row. */
export function registerDownloadsSingleRowCommands(
  reporter: Reporter, viewSelection: () => readonly DownloadsTreeNode[],
): vscode.Disposable[] {
  return [
    registerGesture('modbench.downloadedFile.open', viewSelection, async (entry) => {
      const row = singularArgument(entry, 'downloadedFile')?.argument.row;
      if (!row) return;
      await reportFailure(reporter, `Open File for "${row.name}" failed.`, async () => {
        await vscode.env.openExternal(vscode.Uri.file(row.path));
      });
    }),
    registerGesture('modbench.downloadedFile.openMeta', viewSelection, async (entry) => {
      const row = singularArgument(entry, 'downloadedFile')?.argument.row;
      if (!row) return;
      await reportFailure(reporter, `Open Metadata for "${row.name}" failed.`, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(row.metadataPath));
      });
    }),
  ];
}

/** Acts on the whole selection, applying the clicked row's action to a mixed one (the reference
 *  tool's Hide All). `viewSelection` backs the Delete key and the palette, which get no row
 *  argument. */
export function registerDownloadsMultiRowCommands(
  commands: DownloadedFileCommands, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
  log: (line: string) => void, viewSelection: () => readonly DownloadsTreeNode[],
): vscode.Disposable[] {
  return [
    registerAgentGesture('modbench.downloadedFile.delete', viewSelection, deleteGesture(commands, instance, reporter, ask, trash, log)),
    registerAgentGesture('modbench.downloadedFile.exclude', viewSelection, markGesture(commands, instance, reporter, true)),
    registerAgentGesture('modbench.downloadedFile.include', viewSelection, markGesture(commands, instance, reporter, false)),
  ];
}

// Sorting and excluded-row filtering already happen inside DownloadsProvider's load(), so these
// take the provider rather than the instance root as the per-downloaded-file commands above do.

// Filetime descending, last, is the default DownloadsProvider already starts at, so leaving it
// unpicked changes nothing.
const SORT_OPTIONS: readonly { label: string; column: DownloadedFileSortColumn; descending: boolean }[] = [
  { label: 'Name (A to Z)', column: 'name', descending: false },
  { label: 'Name (Z to A)', column: 'name', descending: true },
  { label: 'Download Status (A to Z)', column: 'status', descending: false },
  { label: 'Download Status (Z to A)', column: 'status', descending: true },
  { label: 'Size (Smallest First)', column: 'size', descending: false },
  { label: 'Size (Largest First)', column: 'size', descending: true },
  { label: 'Filetime (Oldest First)', column: 'mtimeMs', descending: false },
  { label: 'Filetime (Newest First)', column: 'mtimeMs', descending: true },
];

type SortOption = { label: string; column: DownloadedFileSortColumn; descending: boolean };

function pickSort(current: { column: DownloadedFileSortColumn; descending: boolean }): Promise<SortOption | undefined> {
  const active = SORT_OPTIONS.find((o) => o.column === current.column && o.descending === current.descending);
  return pickWithMarked(SORT_OPTIONS, active, 'Sort downloads by');
}

/** A quick pick rather than column headers, which a tree does not have. Escape is a silent
 *  no-op, matching the profile picker. */
export function registerDownloadsSortCommand(
  downloadsProvider: Pick<DownloadsProvider, 'setSort' | 'currentSort'>,
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.downloadedFile.sort', async () => {
    const picked = await pickSort(downloadsProvider.currentSort());
    if (!picked) return;
    downloadsProvider.setSort(picked.column, picked.descending);
  });
}

/** Two commands over one context key, as the Mods tree's sort-direction toggle does: state
 *  lives on the provider, the handler owns the key package.json's `when` clauses gate on. */
export function registerDownloadsExcludedToggleCommands(
  downloadsProvider: Pick<DownloadsProvider, 'setShowExcluded'>,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloadedFile.showExcluded', () => {
      downloadsProvider.setShowExcluded(true);
      void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.excludedShown', true);
    }),
    vscode.commands.registerCommand('modbench.downloadedFile.hideExcluded', () => {
      downloadsProvider.setShowExcluded(false);
      void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.excludedShown', false);
    }),
  ];
}
