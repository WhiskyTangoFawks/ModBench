import * as vscode from 'vscode';
import type { DownloadSortColumn } from './downloadRows';
import {
  deleteDownloads, excludeDownloads, includeDownloads, type DeletedDownload, type DownloadsAccess,
} from '../downloadsCommands/downloads';
import { installFromArchive, installNameRefusal, type InstallAccess } from '../install/install';
import type { DownloadsProvider, DownloadsTreeNode } from './DownloadsProvider';
import { DOWNLOADS_KEY_ARGS } from './keyContext';
import { pluralArgument, registerGesture, singularArgument, type GestureEntry } from '../drivingLib/gestureEntry';
import { pickWithMarked } from '../drivingLib/pickWithMarked';
import { promptModName } from '../drivingLib/promptModName';
import { reportFailure } from '../drivingLib/reportFailure';
import { runWritingGesture } from '../drivingLib/writingGesture';

const runDownloadsWriting = <T>(instance: Pick<Instance, 'refresh'>, command: () => Promise<T>): Promise<T> =>
  runWritingGesture(DOWNLOADS_KEY_ARGS.view, instance, command);
import type { DownloadFile, Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import { chooseInstallTarget } from './installTarget';
import { errorMessage } from '../ports/errorMessage';
import { applyOrThrow } from '../ports/applyOrThrow';
import type { SelectionOutcome } from '../ports/selectionOutcome';

/** The composition root's answers, which is what lets this view call install itself: the FOMOD
 *  notice and an Output line. */
export interface DownloadInstallDeps {
  warnIfFomod: (name: string, isFomod: boolean) => void;
  /** Install's failed-mark line, and delete's left-behind metadata line — no notification either way. */
  log: (line: string) => void;
}

// The row holds the archive's path and its own mod id, file id and version, so the view re-reads
// no sidecar; install is called for what it is, and install marks the download installed.
export async function installDownloadedFile(
  row: DownloadFile, access: InstallAccess, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter,
  deps: DownloadInstallDeps,
): Promise<boolean> {
  const { name } = row;
  let downloadRefusal: string | undefined;
  try {
    const target = await chooseInstallTarget(
      instance.value, row, (defaultName) => promptModName(defaultName, (name) => installNameRefusal(access, name)));
    if (!target) return false;
    await runDownloadsWriting(instance, async () => {
      const outcome = await installFromArchive(access, target, row.path, {
        gameName: instance.value.gameName, modID: row.modID, fileID: row.fileID, version: row.version,
      });
      applyOrThrow(outcome);
      deps.warnIfFomod(target.name, outcome.isFomod);
      downloadRefusal = outcome.downloadRefusal;
    });
  } catch (err) {
    // ADR-0019.
    reporter.report('error', `Failed to install "${name}".`, errorMessage(err));
    return false;
  }
  if (downloadRefusal === undefined) return true;
  // downloads.md, Reporting story 1: the install landed, so it is not reported as failed — the
  // row still shows Installed, straight off meta.ini, and the failed mark is one Output line.
  deps.log(`"${name}" was installed, but its Downloads status could not be updated: ${downloadRefusal}`);
  return true;
}

// One question for the whole selection: an N-file selection must not stack N modal dialogs.
async function confirmDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const [only] = names;
  const question = names.length === 1 && only !== undefined
    ? `Delete "${only}"? It will be moved to the system trash. The installed mod, if any, is untouched.`
    : `Delete ${names.length} items? They will be moved to the system trash. The installed mod, if any, is untouched.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

const NOTHING_CHANGED: SelectionOutcome<string> = { landed: [], refused: [] };

// Metadata left behind is not a failure (downloads.md, Reporting story 2): the delete already
// applied, so this is an Output-only line, never a notification.
async function deleteSelection(
  access: DownloadsAccess, instance: Pick<Instance, 'value' | 'refresh'>, rows: readonly DownloadFile[], reporter: Reporter,
  ask: AskQuestion, trash: MoveToTrash, log: (line: string) => void,
): Promise<SelectionOutcome<DeletedDownload>> {
  if (rows.length === 0 || !(await confirmDelete(rows.map((row) => row.name), ask))) return { landed: [], refused: [] };
  const outcome = await runDownloadsWriting(instance, () => deleteDownloads(access, rows, trash));
  reporter.selectionOutcome(
    `Could not delete ${outcome.refused.length} of ${rows.length} downloaded files.`, outcome, (item) => item.name);
  for (const item of outcome.landed) {
    if (item.metadataLeftBehind !== undefined) {
      log(`"${item.name}" was deleted, but its ${instance.value.managerNames.downloadMetadataFile} could not be moved to the trash and was left behind: ${item.metadataLeftBehind}`);
    }
  }
  return outcome;
}

async function changeExcluded(
  access: DownloadsAccess, instance: Pick<Instance, 'refresh'>, rows: readonly DownloadFile[], excluded: boolean,
  reporter: Reporter,
): Promise<SelectionOutcome<string>> {
  if (rows.length === 0) return NOTHING_CHANGED;
  const names = rows.map((row) => row.name);
  const outcome = await runDownloadsWriting(instance, () =>
    excluded ? excludeDownloads(access, names) : includeDownloads(access, names));
  reporter.selectionOutcome(
    `Could not ${excluded ? 'exclude' : 'include'} ${outcome.refused.length} of ${rows.length} downloaded files.`,
    outcome, (name) => name);
  return outcome;
}

/** Clicked row only, as five opened tabs help no one. The palette hands no row, so open and
 *  open metadata take the one selected row. */
export function registerDownloadsSingleRowCommands(
  reporter: Reporter, viewSelection: () => readonly DownloadsTreeNode[],
): vscode.Disposable[] {
  return [
    registerGesture('modbench.downloadedFile.open', viewSelection, async (entry) => {
      const row = singularArgument(entry, 'download')?.row;
      if (!row) return;
      await reportFailure(reporter, `Open File for "${row.name}" failed.`, async () => {
        await vscode.env.openExternal(vscode.Uri.file(row.path));
      });
    }),
    registerGesture('modbench.downloadedFile.openMeta', viewSelection, async (entry) => {
      const row = singularArgument(entry, 'download')?.row;
      if (!row) return;
      await reportFailure(reporter, `Open Meta File for "${row.name}" failed.`, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(row.sidecarPath));
      });
    }),
  ];
}

/** Acts on the whole selection, applying the clicked row's action to a mixed one (the reference
 *  tool's Hide All). `viewSelection` backs the Delete key and the palette, which get no row
 *  argument. */
export function registerDownloadsMultiRowCommands(
  access: DownloadsAccess, instance: Pick<Instance, 'value' | 'refresh'>, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
  log: (line: string) => void, viewSelection: () => readonly DownloadsTreeNode[],
): vscode.Disposable[] {
  const rows = (entry: GestureEntry<DownloadsTreeNode>) => pluralArgument(entry, 'download').map((node) => node.row);
  return [
    registerGesture('modbench.downloadedFile.delete', viewSelection, (entry) =>
      deleteSelection(access, instance, rows(entry), reporter, ask, trash, log)),
    registerGesture('modbench.downloadedFile.exclude', viewSelection, (entry) =>
      changeExcluded(access, instance, rows(entry), true, reporter)),
    registerGesture('modbench.downloadedFile.include', viewSelection, (entry) =>
      changeExcluded(access, instance, rows(entry), false, reporter)),
  ];
}

// Sorting and excluded-row filtering already happen inside DownloadsProvider's load(), so these
// take the provider rather than the instance root as the per-archive commands above do.

// Filetime descending, last, is the default DownloadsProvider already starts at, so leaving it
// unpicked changes nothing.
const SORT_OPTIONS: readonly { label: string; column: DownloadSortColumn; descending: boolean }[] = [
  { label: 'Name (A to Z)', column: 'name', descending: false },
  { label: 'Name (Z to A)', column: 'name', descending: true },
  { label: 'Download Status (A to Z)', column: 'status', descending: false },
  { label: 'Download Status (Z to A)', column: 'status', descending: true },
  { label: 'Size (Smallest First)', column: 'size', descending: false },
  { label: 'Size (Largest First)', column: 'size', descending: true },
  { label: 'Filetime (Oldest First)', column: 'mtimeMs', descending: false },
  { label: 'Filetime (Newest First)', column: 'mtimeMs', descending: true },
];

type SortOption = { label: string; column: DownloadSortColumn; descending: boolean };

function pickSort(current: { column: DownloadSortColumn; descending: boolean }): Promise<SortOption | undefined> {
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
