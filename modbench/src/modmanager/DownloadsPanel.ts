import * as vscode from 'vscode';
import type { DownloadRow, DownloadSortColumn } from './mo2/downloads';
import { downloadFile, downloadSidecarFile } from './mo2/layout';
import {
  deleteDownload,
  hideDownload,
  markDownloadInstalled,
  unhideDownload,
  type DownloadCommandResult,
} from './commands/downloads';
import { nexusSlugForGame } from './mo2/gamePaths';
import type { InstallChoice } from './commands/install';
import type { DownloadNode, DownloadsProvider } from './DownloadsProvider';
import type { Instance } from './instance';
import type { Reporter } from '../reporter';
import type { AskQuestion } from '../dialog';
import { selectUpgradeCandidates, type UpgradeCandidate } from './upgradeCandidates';
import { present } from '../present';

// The host's trash, the one capability a command cannot hold itself.
const trashFile = async (path: string): Promise<void> => {
  await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A refusal becomes a throw, so one catch-and-report path serves a rejected promise and an
// `{ applied: false }` result alike.
function applyOrThrow(outcome: DownloadCommandResult): void {
  if (!outcome.applied) throw new Error(outcome.refusal);
}

interface UpgradePickItem extends vscode.QuickPickItem {
  /** What install is told this is: an upgrade naming the chosen mod's own folder, or the
   *  trailing "Install as a new mod…" row's new mod, which the name prompt then names. */
  choice: InstallChoice;
}

// The file-id match, if one exists, is first in `candidates` (selectUpgradeCandidates' own
// order), which is what makes it VS Code's default-highlighted row — no explicit activeItem.
function upgradePickItems(candidates: readonly UpgradeCandidate[]): UpgradePickItem[] {
  return [
    ...candidates.map((c) => ({
      label: c.version ? `${c.modName} (v${c.version})` : c.modName,
      description: c.fileIdMatch ? 'File ID match' : undefined,
      choice: { kind: 'upgrade' as const, name: c.modName },
    })),
    { label: 'Install as a new mod…', choice: { kind: 'new' as const } },
  ];
}

// Esc yields no choice at all, which the caller reads as "install nothing" — never "install as
// a new mod", which is its own explicit row.
async function pickUpgradeChoice(name: string, candidates: readonly UpgradeCandidate[]): Promise<InstallChoice | undefined> {
  const picked = await vscode.window.showQuickPick(upgradePickItems(candidates), {
    placeHolder: `"${name}" upgrades an installed mod — choose which one, or install it as a new mod`,
  });
  return picked?.choice;
}

// Pre-supplying the archive path keeps the install command's file-picker from appearing. The
// row's own mod id, file id and version are what it is told: the view re-reads no sidecar.
async function installArchive(
  instanceRoot: string, row: DownloadRow, instance: Pick<Instance, 'value'>, reporter: Reporter,
): Promise<void> {
  const { name } = row;
  let installed = false;
  try {
    const candidates = selectUpgradeCandidates(instance.value, row);
    let choice: InstallChoice = { kind: 'new' };
    if (candidates.length > 0) {
      const picked = await pickUpgradeChoice(name, candidates);
      if (!picked) return; // Esc: install nothing
      choice = picked;
    }
    installed = (await vscode.commands.executeCommand<boolean | undefined>(
      'modbench.modList.installFromArchive',
      downloadFile(instanceRoot, name), row.modID, row.fileID, row.version, choice,
    )) ?? false;
  } catch (err) {
    // ADR-0019: explicit user action failed -> error notification + log.
    reporter.report('error', `Failed to install "${name}".`, message(err));
    return;
  }
  if (!installed) return;
  const marked = await markDownloadInstalled(instanceRoot, name);
  if (marked.applied) return;
  // ADR-0019: integrity/silent-wrong-state (partial save) — the mod IS installed, only its
  // Downloads bookkeeping failed. Must not read as "install failed", or the user may retry and
  // get a duplicate mod.
  reporter.report(
    'warning',
    `"${name}" was installed, but its Downloads status could not be updated — see the Modbench output log.`,
    marked.refusal,
  );
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
    reporter.report('error', `${label} for "${name}" failed.`, message(err));
  }
}

// The caller supplies `confirm`, so a batch delete can ask once for the whole selection instead
// of once per file. Cancel is a silent no-op.
async function trashOneArchive(
  instanceRoot: string,
  name: string,
  reporter: Reporter,
  confirm: () => Promise<boolean>,
): Promise<void> {
  if (!(await confirm())) return;
  const outcome = await deleteDownload(instanceRoot, name, trashFile);
  if (outcome.applied) return;
  // ADR-0019: explicit user action failed -> error notification + log.
  reporter.report('error', `Failed to delete "${name}".`, outcome.refusal);
}

async function deleteArchive(
  instanceRoot: string, name: string, reporter: Reporter, ask: AskQuestion,
): Promise<void> {
  await trashOneArchive(instanceRoot, name, reporter, async () =>
    (await ask(
      `Delete "${name}"? The archive and its .meta file (if any) will be moved to the system trash.`,
      { modal: true },
      'Delete',
    )) === 'Delete');
}

/** Confirms once for the whole selection: an N-file selection must not stack N modal dialogs.
 *  Cancel is a silent no-op for the whole batch, matching the single-file contract. */
export async function deleteArchives(
  instanceRoot: string, names: string[], reporter: Reporter, ask: AskQuestion,
): Promise<void> {
  if (names.length === 1) {
    await deleteArchive(instanceRoot, present(names[0], 'the sole selected archive name'), reporter, ask);
    return;
  }
  const confirmed = (await ask(
    `Delete ${names.length} items? Each archive and its .meta file (if any) will be moved to the system trash.`,
    { modal: true },
    'Delete',
  )) === 'Delete';
  if (!confirmed) return;
  for (const name of names) await trashOneArchive(instanceRoot, name, reporter, () => Promise.resolve(true));
}

// The game and the mod id both come from the value, which holds them already.
async function visitOnNexus(gameRelease: string, modID: string): Promise<void> {
  const slug = nexusSlugForGame(gameRelease);
  await vscode.env.openExternal(vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${modID}`));
}

/** Clicked row only, ignoring the rest of any multi-selection: MO2 does not batch Install
 *  either, and batching the navigational actions is "open five browser tabs". VS Code's
 *  `(clickedItem, selectedItems[])` selection argument is unused here. */
export function registerDownloadsSingleRowCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>, reporter: Reporter,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.install', (node?: DownloadNode) => {
      if (node?.row.name) void installArchive(instanceRoot, node.row, instance, reporter);
    }),
    // A no-op without a mod id; the native menu's `hasModID` `when` clause is the other guard.
    vscode.commands.registerCommand('modbench.downloads.visitNexus', (node?: DownloadNode) => {
      const row = node?.row;
      if (!row?.modID) return;
      const modID = row.modID;
      void runRowAction('Visit on Nexus', row.name, reporter, () => visitOnNexus(instance.value.gameRelease, modID));
    }),
    // OS-open the archive in the system's associated application.
    vscode.commands.registerCommand('modbench.downloads.openFile', (node?: DownloadNode) => {
      const name = node?.row.name;
      if (!name) return;
      void runRowAction('Open File', name, reporter, async () => {
        await vscode.env.openExternal(vscode.Uri.file(downloadFile(instanceRoot, name)));
      });
    }),
    // Open the `.meta` sidecar in the editor (gated off in the native menu when absent).
    vscode.commands.registerCommand('modbench.downloads.openMeta', (node?: DownloadNode) => {
      const name = node?.row.name;
      if (!name) return;
      void runRowAction('Open Meta File', name, reporter, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(downloadSidecarFile(instanceRoot, name)));
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
  instanceRoot: string, reporter: Reporter, ask: AskQuestion,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.delete', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      const names = selectionNames(clicked, selected);
      if (names.length > 0) void deleteArchives(instanceRoot, names, reporter, ask);
    }),
    vscode.commands.registerCommand('modbench.downloads.hide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Hide', name, reporter, async () => applyOrThrow(await hideDownload(instanceRoot, name)));
      }
    }),
    vscode.commands.registerCommand('modbench.downloads.unhide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Unhide', name, reporter, async () => applyOrThrow(await unhideDownload(instanceRoot, name)));
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

/** A quick pick rather than column headers, which a tree does not have. Escape is a silent
 *  no-op, matching the profile picker. */
export function registerDownloadsSortCommand(downloadsProvider: DownloadsProvider): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.downloads.sortBy', async () => {
    const picked = await vscode.window.showQuickPick(SORT_OPTIONS, { placeHolder: 'Sort downloads by' });
    if (!picked) return;
    downloadsProvider.setSort(picked.column, picked.descending);
  });
}

/** Two commands over one context key, as the Mods tree's sort-direction toggle does: state
 *  lives on the provider, the handler owns the key package.json's `when` clauses gate on. */
export function registerDownloadsHiddenToggleCommands(downloadsProvider: DownloadsProvider): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.showHidden', () => {
      downloadsProvider.setShowHidden(true);
      void vscode.commands.executeCommand('setContext', 'modbench.downloads.showHidden', true);
    }),
    vscode.commands.registerCommand('modbench.downloads.hideHidden', () => {
      downloadsProvider.setShowHidden(false);
      void vscode.commands.executeCommand('setContext', 'modbench.downloads.showHidden', false);
    }),
  ];
}
