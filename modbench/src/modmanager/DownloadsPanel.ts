import * as vscode from 'vscode';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDownloadMeta, setHiddenInText, setInstalledInText, type DownloadEntry, type DownloadSortColumn } from './mo2/downloads';
import { deleteDownload } from './deleteDownload';
import { readGameName } from './mo2/modOrganizerIni';
import { nexusSlugForGame } from './mo2/gamePaths';
import type { InstallChoice } from './commands/install';
import type { DownloadNode, DownloadsProvider } from './DownloadsProvider';
import type { Instance } from './instance';
import { selectUpgradeCandidates, type UpgradeCandidate } from './upgradeCandidates';

// A metaless archive is a valid Downloaded row, so an absent sidecar is undefined, not an error.
async function readMetaText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function scanDownloads(instanceRoot: string): Promise<DownloadEntry[] | undefined> {
  const dir = join(instanceRoot, 'downloads');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  // .meta sidecars are suppressed as rows by buildDownloadRows, not filtered
  // here too — one place owns the suppression rule.
  return Promise.all(
    names.map(async (name) => {
      const filePath = join(dir, name);
      const [info, metaText] = await Promise.all([stat(filePath), readMetaText(`${filePath}.meta`)]);
      return { name, size: info.size, mtimeMs: info.mtimeMs, metaText };
    }),
  );
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
// `.meta` write is what the file-watcher turns into a Status refresh, so none is issued here.
async function installArchive(
  instanceRoot: string, name: string, instance: Pick<Instance, 'value'>, log: (msg: string) => void,
): Promise<void> {
  const archivePath = join(instanceRoot, 'downloads', name);
  const metaPath = `${archivePath}.meta`;
  let installed = false;
  try {
    const metaText = (await readMetaText(metaPath)) ?? '';
    const { modID, fileID, version } = parseDownloadMeta(metaText);
    const candidates = selectUpgradeCandidates(instance.value, { modID, fileID });
    let choice: InstallChoice = { kind: 'new' };
    if (candidates.length > 0) {
      const picked = await pickUpgradeChoice(name, candidates);
      if (!picked) return; // Esc: install nothing
      choice = picked;
    }
    installed = (await vscode.commands.executeCommand<boolean | undefined>(
      'modbench.modList.installFromArchive',
      archivePath, modID, fileID, version, choice,
    )) ?? false;
    if (!installed) return;
    await writeFile(metaPath, setInstalledInText(metaText), 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (installed) {
      // ADR-0026: integrity/silent-wrong-state (partial save) — the mod IS
      // installed, only its Downloads bookkeeping failed. Must not read as
      // "install failed", or the user may retry and get a duplicate mod.
      log(`[DownloadsPanel] "${name}" installed but updating its Downloads status failed: ${message}`);
      void vscode.window.showWarningMessage(
        `Modbench: "${name}" was installed, but its Downloads status could not be updated — see the Modbench output log.`,
      );
    } else {
      log(`[DownloadsPanel] installing "${name}" failed: ${message}`);
      // ADR-0026: explicit user action failed -> error notification + log.
      void vscode.window.showErrorMessage(`Modbench: Failed to install "${name}".`);
    }
  }
}

// Every nav action can reject — a `.meta` raced away, an OS with no handler — so none may be
// fire-and-forget. Failure surfacing is ADR-0026.
async function runRowAction(
  label: string,
  name: string,
  log: (msg: string) => void,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[DownloadsPanel] ${label} for "${name}" failed: ${message}`);
    void vscode.window.showErrorMessage(`Modbench: ${label} for "${name}" failed.`);
  }
}

// The caller supplies `confirm`, so a batch delete can ask once for the whole selection instead
// of once per file. Never touches the installed mod.
async function trashOneArchive(
  instanceRoot: string,
  name: string,
  log: (msg: string) => void,
  confirm: () => Promise<boolean>,
): Promise<void> {
  const archivePath = join(instanceRoot, 'downloads', name);
  const metaPath = `${archivePath}.meta`;
  await deleteDownload({
    archivePath,
    metaPath,
    confirm,
    metaExists: async () => (await readMetaText(metaPath)) !== undefined,
    trash: async (path) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(path), { useTrash: true });
    },
    reportFailure: (message) => {
      log(`[DownloadsPanel] deleting "${name}" failed: ${message}`);
      // ADR-0026: explicit user action failed -> error notification + log.
      void vscode.window.showErrorMessage(`Modbench: Failed to delete "${name}".`);
    },
  });
}

async function deleteArchive(instanceRoot: string, name: string, log: (msg: string) => void): Promise<void> {
  await trashOneArchive(instanceRoot, name, log, async () =>
    (await vscode.window.showWarningMessage(
      `Delete "${name}"? The archive and its .meta file (if any) will be moved to the system trash.`,
      { modal: true },
      'Delete',
    )) === 'Delete');
}

/** Confirms once for the whole selection: an N-file selection must not stack N modal dialogs.
 *  Cancel is a silent no-op for the whole batch, matching the single-file contract. */
export async function deleteArchives(instanceRoot: string, names: string[], log: (msg: string) => void): Promise<void> {
  if (names.length === 1) {
    await deleteArchive(instanceRoot, names[0], log);
    return;
  }
  const confirmed = (await vscode.window.showWarningMessage(
    `Delete ${names.length} items? Each archive and its .meta file (if any) will be moved to the system trash.`,
    { modal: true },
    'Delete',
  )) === 'Delete';
  if (!confirmed) return;
  for (const name of names) await trashOneArchive(instanceRoot, name, log, () => Promise.resolve(true));
}

// A no-op without a mod id; the native menu's `hasModID` `when` clause is the other guard.
async function visitOnNexus(instanceRoot: string, name: string): Promise<void> {
  const metaText = await readMetaText(join(instanceRoot, 'downloads', `${name}.meta`));
  const modID = metaText ? parseDownloadMeta(metaText).modID : undefined;
  if (!modID) return;
  const slug = nexusSlugForGame(readGameName(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8')));
  await vscode.env.openExternal(vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${modID}`));
}

// `removed` is a separate axis from the Uninstalled Status, so this never touches Status. A
// metaless download gets a fresh minimal `.meta`, matching MO2's own QSettings auto-create.
async function setArchiveHidden(instanceRoot: string, name: string, hidden: boolean): Promise<void> {
  const metaPath = join(instanceRoot, 'downloads', `${name}.meta`);
  const metaText = (await readMetaText(metaPath)) ?? '';
  await writeFile(metaPath, setHiddenInText(metaText, hidden), 'utf8');
}

/** Clicked row only, ignoring the rest of any multi-selection: MO2 does not batch Install
 *  either, and batching the navigational actions is "open five browser tabs". VS Code's
 *  `(clickedItem, selectedItems[])` selection argument is unused here. */
export function registerDownloadsSingleRowCommands(
  instanceRoot: string, instance: Pick<Instance, 'value'>, log: (msg: string) => void,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.install', (node?: DownloadNode) => {
      if (node?.row.name) void installArchive(instanceRoot, node.row.name, instance, log);
    }),
    vscode.commands.registerCommand('modbench.downloads.visitNexus', (node?: DownloadNode) => {
      const name = node?.row.name;
      if (name) void runRowAction('Visit on Nexus', name, log, () => visitOnNexus(instanceRoot, name));
    }),
    // OS-open the archive in the system's associated application.
    vscode.commands.registerCommand('modbench.downloads.openFile', (node?: DownloadNode) => {
      const name = node?.row.name;
      if (!name) return;
      void runRowAction('Open File', name, log, async () => {
        await vscode.env.openExternal(vscode.Uri.file(join(instanceRoot, 'downloads', name)));
      });
    }),
    // Open the `.meta` sidecar in the editor (gated off in the native menu when absent).
    vscode.commands.registerCommand('modbench.downloads.openMeta', (node?: DownloadNode) => {
      const name = node?.row.name;
      if (!name) return;
      void runRowAction('Open Meta File', name, log, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(join(instanceRoot, 'downloads', `${name}.meta`)));
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
export function registerDownloadsMultiRowCommands(instanceRoot: string, log: (msg: string) => void): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('modbench.downloads.delete', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      const names = selectionNames(clicked, selected);
      if (names.length > 0) void deleteArchives(instanceRoot, names, log);
    }),
    vscode.commands.registerCommand('modbench.downloads.hide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Hide', name, log, () => setArchiveHidden(instanceRoot, name, true));
      }
    }),
    vscode.commands.registerCommand('modbench.downloads.unhide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) {
        void runRowAction('Unhide', name, log, () => setArchiveHidden(instanceRoot, name, false));
      }
    }),
  ];
}

// Sorting and hidden-row filtering already happen inside DownloadsProvider's load(), so these
// take the provider rather than instanceRoot/log as the per-archive commands above do.

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
