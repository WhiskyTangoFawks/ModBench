import * as vscode from 'vscode';
import type { DownloadSortColumn } from './downloadRows';
import { deleteDownloads, excludeDownload, includeDownload } from '../downloadsCommands/downloads';
import { defaultModName, installFromArchive, type InstallChoice, type InstallTarget } from '../install/install';
import type { DownloadNode, DownloadsProvider } from './DownloadsProvider';
import type { DownloadFile, Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import { selectUpgradeCandidates, type UpgradeCandidate, type UpgradeTier } from './upgradeCandidates';
import { errorMessage } from '../ports/errorMessage';
import { applyOrThrow } from '../ports/applyOrThrow';
import type { SelectionOutcome } from '../ports/selectionOutcome';

interface UpgradePickItem extends vscode.QuickPickItem {
  /** What install is told this is: an upgrade naming the chosen mod's own folder, or the
   *  trailing "Install as a new mod…" row's new mod, which the name prompt then names. */
  choice: InstallChoice;
}

const TIER_LABEL: Record<UpgradeTier, string> = {
  fileId: 'File ID match',
  installationFile: 'Installed from this file',
};

const NEW_MOD_ITEM = { label: 'Install as a new mod…', choice: { kind: 'new' as const } };

// The top tier, if one exists, sorts first; the new-mod row is always last.
function upgradePickItems(candidates: readonly UpgradeCandidate[]): UpgradePickItem[] {
  return [
    ...candidates.map((c) => ({
      label: c.version ? `${c.modName} (v${c.version})` : c.modName,
      description: c.tier && TIER_LABEL[c.tier],
      choice: { kind: 'upgrade' as const, name: c.modName },
    })),
    NEW_MOD_ITEM,
  ];
}

// Esc: no choice, "install nothing". The active item is set explicitly, not left to list order —
// with no tier present it is the new-mod row.
async function pickUpgradeChoice(name: string, candidates: readonly UpgradeCandidate[]): Promise<InstallChoice | undefined> {
  const items = upgradePickItems(candidates);
  const hasTier = candidates.some((c) => c.tier !== undefined);
  const active = hasTier ? items[0] : items.at(-1);
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<UpgradePickItem>();
    quickPick.items = items;
    quickPick.placeholder = `"${name}" upgrades an installed mod — choose which one, or install it as a new mod`;
    quickPick.activeItems = active ? [active] : [];
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      const [picked] = quickPick.selectedItems;
      quickPick.hide();
      resolve(picked?.choice);
    });
    quickPick.onDidHide(() => {
      if (!accepted) resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}

/** The composition root's answers, which is what lets this view call install itself: the name
 *  only the user can give a new mod, the FOMOD notice, and the failed-mark Output line. */
export interface DownloadInstallDeps {
  /** `undefined` is the user declining to name it, which installs nothing. */
  nameNewMod: (defaultName: string) => Thenable<string | undefined>;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  log: (line: string) => void;
}

// An upgrade arrives already confirmed from the pick above and names its own folder, so only a
// new mod reaches the name prompt.
async function resolveTarget(
  choice: InstallChoice, archivePath: string, nameNewMod: DownloadInstallDeps['nameNewMod'],
): Promise<InstallTarget | undefined> {
  if (choice.kind === 'upgrade') return choice;
  const name = await nameNewMod(defaultModName(archivePath));
  return name ? { kind: 'new', name } : undefined;
}

// The row holds the archive's path and its own mod id, file id and version, so the view re-reads
// no sidecar; install is called for what it is, and install marks the download installed.
async function installArchive(
  row: DownloadFile, instanceRoot: string, instance: Pick<Instance, 'value'>, reporter: Reporter,
  deps: DownloadInstallDeps,
): Promise<void> {
  const { name } = row;
  let downloadRefusal: string | undefined;
  try {
    const candidates = selectUpgradeCandidates(instance.value, row);
    let choice: InstallChoice = { kind: 'new' };
    if (candidates.length > 0) {
      const picked = await pickUpgradeChoice(name, candidates);
      if (!picked) return; // Esc: install nothing
      choice = picked;
    }
    const target = await resolveTarget(choice, row.path, deps.nameNewMod);
    if (!target) return;
    const outcome = await installFromArchive(instanceRoot, target, row.path, {
      gameName: instance.value.gameRelease, modID: row.modID, fileID: row.fileID, version: row.version,
    });
    applyOrThrow(outcome);
    deps.warnIfFomod(target.name, outcome.isFomod);
    downloadRefusal = outcome.downloadRefusal;
  } catch (err) {
    // ADR-0019: explicit user action failed -> error notification + log.
    reporter.report('error', `Failed to install "${name}".`, errorMessage(err));
    return;
  }
  if (downloadRefusal === undefined) return;
  // downloads.md, Reporting story 1: the install landed, so it is not reported as failed — the
  // row still shows Installed, straight off meta.ini, and the failed mark is one Output line.
  deps.log(`"${name}" was installed, but its Downloads status could not be updated: ${downloadRefusal}`);
}

// Every nav action can reject — a `.meta` raced away, an OS with no handler — so none may be
// fire-and-forget. Failure surfacing is ADR-0019.
async function runRowAction(
  label: string,
  name: string,
  reporter: Reporter,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    reporter.report('error', `${label} for "${name}" failed.`, errorMessage(err));
  }
}

// One question for the whole selection: an N-file selection must not stack N modal dialogs.
async function confirmDelete(names: readonly string[], ask: AskQuestion): Promise<boolean> {
  const [only] = names;
  const question = names.length === 1 && only !== undefined
    ? `Delete "${only}"? The archive and its .meta file (if any) will be moved to the system trash.`
    : `Delete ${names.length} items? Each archive and its .meta file (if any) will be moved to the system trash.`;
  return (await ask(question, { modal: true }, 'Delete')) === 'Delete';
}

const NOTHING_DELETED: SelectionOutcome<string> = { landed: [], refused: [] };

async function deleteSelection(
  instanceRoot: string, names: readonly string[], reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
): Promise<SelectionOutcome<string>> {
  if (names.length === 0 || !(await confirmDelete(names, ask))) return NOTHING_DELETED;
  const outcome = await deleteDownloads(instanceRoot, names, trash);
  reporter.selectionOutcome(
    `Could not delete ${outcome.refused.length} of ${names.length} downloaded files.`, outcome, (name) => name);
  return outcome;
}

/** Clicked row only, ignoring the rest of any multi-selection: MO2 does not batch Install
 *  either, and batching the navigational actions is "open five browser tabs". VS Code's
 *  `(clickedItem, selectedItems[])` selection argument is unused here. */
export function registerDownloadsSingleRowCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>, reporter: Reporter, install: DownloadInstallDeps,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.install', (node?: DownloadNode) => {
      if (node?.row.name) void installArchive(node.row, instanceRoot, instance, reporter, install);
    }),
    vscode.commands.registerCommand('modbench.downloadedFile.open', async (node?: DownloadNode) => {
      const row = node?.row;
      if (!row) return;
      await runRowAction('Open File', row.name, reporter, async () => {
        await vscode.env.openExternal(vscode.Uri.file(row.path));
      });
    }),
    vscode.commands.registerCommand('modbench.downloadedFile.openMeta', async (node?: DownloadNode) => {
      const row = node?.row;
      if (!row) return;
      await runRowAction('Open Meta File', row.name, reporter, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(row.sidecarPath));
      });
    }),
  ];
}

// A host that supplies no selection array, and a single-row click, both fall back to the
// clicked row alone.
function selectionNames(clicked: DownloadNode | undefined, selected: DownloadNode[] | undefined): string[] {
  if (selected && selected.length > 0) return selected.map((n) => n.row.name);
  return clicked ? [clicked.row.name] : [];
}

/** Acts on the whole selection. The `when` clause can only inspect the clicked row, so a mixed
 *  selection applies that row's action to all of them, as MO2's "Hide All" does. */
export function registerDownloadsMultiRowCommands(
  instanceRoot: string, reporter: Reporter, ask: AskQuestion, trash: MoveToTrash,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloadedFile.delete', (clicked?: DownloadNode, selected?: DownloadNode[]) =>
      deleteSelection(instanceRoot, selectionNames(clicked, selected), reporter, ask, trash)),
    vscode.commands.registerCommand('modbench.downloadedFile.exclude', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Exclude', name, reporter, async () => applyOrThrow(await excludeDownload(instanceRoot, name)));
      }
    }),
    vscode.commands.registerCommand('modbench.downloadedFile.include', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Include', name, reporter, async () => applyOrThrow(await includeDownload(instanceRoot, name)));
      }
    }),
  ];
}

// Sorting and hidden-row filtering already happen inside DownloadsProvider's load(), so these
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

// createQuickPick, not showQuickPick: only the former lets the pick mark the current sort as its
// active item (downloads.md, Order and view state, story 2), the same pattern the upgrade pick
// above uses for its own pre-selection.
async function pickSort(current: { column: DownloadSortColumn; descending: boolean }): Promise<SortOption | undefined> {
  const active = SORT_OPTIONS.find((o) => o.column === current.column && o.descending === current.descending);
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<SortOption>();
    quickPick.items = SORT_OPTIONS;
    quickPick.placeholder = 'Sort downloads by';
    quickPick.activeItems = active ? [active] : [];
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      const [picked] = quickPick.selectedItems;
      quickPick.hide();
      resolve(picked);
    });
    quickPick.onDidHide(() => {
      if (!accepted) resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
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
export function registerDownloadsHiddenToggleCommands(
  downloadsProvider: Pick<DownloadsProvider, 'setShowHidden'>,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloadedFile.showExcluded', () => {
      downloadsProvider.setShowHidden(true);
      void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.excludedShown', true);
    }),
    vscode.commands.registerCommand('modbench.downloadedFile.hideExcluded', () => {
      downloadsProvider.setShowHidden(false);
      void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.excludedShown', false);
    }),
  ];
}
