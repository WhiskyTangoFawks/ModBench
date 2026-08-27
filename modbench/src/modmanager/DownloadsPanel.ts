import * as vscode from 'vscode';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDownloadMeta, setHiddenInText, setInstalledInText, type DownloadEntry, type DownloadSortColumn } from './mo2/downloads';
import { deleteDownload } from './deleteDownload';
import { readGameName } from './mo2/modOrganizerIni';
import { nexusSlugForGame } from './mo2/nexusSlug';
import type { DownloadNode, DownloadsProvider } from './DownloadsProvider';

/** Best-effort read of an archive's `.meta` sidecar text; absent -> undefined
 *  (a metaless archive is a valid Downloaded row, per the spec). */
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

/** Row Install action: delegate to the existing installFromArchive command
 *  (pre-supplying the archive path so no file-picker appears), and on
 *  success write `installed=true` back to the .meta sidecar. The Downloads
 *  panel's file-watcher picks up that .meta change and refreshes the row's
 *  Status on its own — no explicit refresh needed here. */
async function installArchive(instanceRoot: string, name: string, log: (msg: string) => void): Promise<void> {
  const archivePath = join(instanceRoot, 'downloads', name);
  let installed = false;
  try {
    installed = (await vscode.commands.executeCommand<boolean>(
      'modbench.modList.installFromArchive',
      archivePath,
    )) ?? false;
    if (!installed) return;
    const metaPath = `${archivePath}.meta`;
    const metaText = (await readMetaText(metaPath)) ?? '';
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

/** Run a per-row navigational action, surfacing any failure per ADR-0026
 *  (an explicit user action failing → error notification + output log). The
 *  thin nav actions (open/reveal/visit) can all reject — e.g. a `.meta` raced
 *  away, an OS with no handler — so none may be fire-and-forget. */
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

/** Trash one archive + its `.meta` sidecar (if any) — no confirmation of its own; the caller
 *  (deleteArchive / deleteArchives) supplies `confirm`, so a batch delete can ask once for the
 *  whole selection instead of once per file. All sequencing/ordering lives in the injected-dep
 *  `deleteDownload` (unit-tested); this adapter only supplies the VS Code surface — trash via
 *  `workspace.fs.delete` with `useTrash`, and ADR-0026 failure surfacing. The file-watcher
 *  removes the row on its own once the archive leaves disk. Never touches the installed mod. */
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

/** Row Delete action (single file): move the archive and its `.meta` sidecar (if any) to the
 *  system trash, behind a modal confirmation naming the file. */
async function deleteArchive(instanceRoot: string, name: string, log: (msg: string) => void): Promise<void> {
  await trashOneArchive(instanceRoot, name, log, async () =>
    (await vscode.window.showWarningMessage(
      `Delete "${name}"? The archive and its .meta file (if any) will be moved to the system trash.`,
      { modal: true },
      'Delete',
    )) === 'Delete');
}

/** Delete action for the tree's multi-select command (#233): confirms ONCE for the WHOLE
 *  selection, never once per file — an N-file selection must not stack N modal dialogs. A
 *  single-name selection reuses `deleteArchive` as-is (identical modal text to before #233).
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

/** Row Visit-on-Nexus action: read the archive's `.meta` for the Nexus mod id
 *  and the instance's game for the slug, then open the mod's Nexus page. No-op
 *  when there's no mod id (the native menu's `when` clause, gated on `hasModID`
 *  in the row's data-vscode-context, also keeps the command off the menu). */
async function visitOnNexus(instanceRoot: string, name: string): Promise<void> {
  const metaText = await readMetaText(join(instanceRoot, 'downloads', `${name}.meta`));
  const modID = metaText ? parseDownloadMeta(metaText).modID : undefined;
  if (!modID) return;
  const slug = nexusSlugForGame(readGameName(await readFile(join(instanceRoot, 'ModOrganizer.ini'), 'utf8')));
  await vscode.env.openExternal(vscode.Uri.parse(`https://www.nexusmods.com/${slug}/mods/${modID}`));
}

/** Row Hide/Unhide action: surgically set `.meta` `removed=true/false` and write
 *  it back byte-faithfully. `hidden` is the SEPARATE axis from the Uninstalled
 *  Status (`uninstalled=true`) — this never touches Status. A metaless download
 *  gets a fresh minimal `.meta` (setHiddenInText('', true)), matching MO2's own
 *  QSettings auto-create. The file-watcher rescan makes the row disappear/appear;
 *  runRowAction gives ADR-0026 explicit-action-failed surfacing. */
async function setArchiveHidden(instanceRoot: string, name: string, hidden: boolean): Promise<void> {
  const metaPath = join(instanceRoot, 'downloads', `${name}.meta`);
  const metaText = (await readMetaText(metaPath)) ?? '';
  await writeFile(metaPath, setHiddenInText(metaText, hidden), 'utf8');
}

// #214: the row's right-click actions (Install/Visit on Nexus/Open File/Open Meta File/
// Reveal in Explorer/Delete/Hide/Unhide) as directly-callable handlers, keyed the same way
// buildMessageHandlers used to key them before their sole trigger — the hand-drawn row menu —
// moved to a native `webview/context` menu. All the real work already lived here in the
// extension host (never in the webview), so the native commands below call these directly;
// no message round trip needed. Exported/testable the same fixture-in/behavior-out way
// buildMessageHandlers was (DownloadsPanel.test.ts).
export function buildRowActionHandlers(instanceRoot: string, log: (msg: string) => void): Record<string, (name: string) => void> {
  return {
    install: (name) => void installArchive(instanceRoot, name, log),
    visitNexus: (name) =>
      void runRowAction('Visit on Nexus', name, log, () => visitOnNexus(instanceRoot, name)),
    // OS-open the archive in the system's associated application.
    openFile: (name) =>
      void runRowAction('Open File', name, log, async () => {
        await vscode.env.openExternal(vscode.Uri.file(join(instanceRoot, 'downloads', name)));
      }),
    // Open the `.meta` sidecar in the editor (gated off in the native menu when absent).
    openMeta: (name) =>
      void runRowAction('Open Meta File', name, log, async () => {
        await vscode.window.showTextDocument(vscode.Uri.file(join(instanceRoot, 'downloads', `${name}.meta`)));
      }),
    delete: (name) => void deleteArchive(instanceRoot, name, log),
    hide: (name) => void runRowAction('Hide', name, log, () => setArchiveHidden(instanceRoot, name, true)),
    unhide: (name) => void runRowAction('Unhide', name, log, () => setArchiveHidden(instanceRoot, name, false)),
  };
}

// #233: one command id per native `view/item/context` menu entry on the modbench.downloads
// TreeView (package.json's contributes.commands/menus), mapped to its buildRowActionHandlers
// key. `keyof ReturnType<typeof buildRowActionHandlers>` (not a bare `string`) so a typo'd or
// renamed key on either side of this table is a compile error, not a silent no-op at that one
// command.
const SINGLE_ROW_COMMANDS: Record<string, keyof ReturnType<typeof buildRowActionHandlers>> = {
  'modbench.downloads.install': 'install',
  'modbench.downloads.visitNexus': 'visitNexus',
  'modbench.downloads.openFile': 'openFile',
  'modbench.downloads.openMeta': 'openMeta',
};

/** Register Install / Visit on Nexus / Open File / Open Meta File — clicked row only, ignoring
 *  the rest of any multi-selection (#233): MO2 doesn't batch Install either, and batching the
 *  navigational actions is "open five browser tabs / five archives / five editors". VS Code
 *  invokes a contributed `view/item/context` command as `(clickedItem, selectedItems[])`; the
 *  selection argument is simply unused here. */
export function registerDownloadsSingleRowCommands(instanceRoot: string, log: (msg: string) => void): vscode.Disposable[] {
  const handlers = buildRowActionHandlers(instanceRoot, log);
  return Object.entries(SINGLE_ROW_COMMANDS).map(([commandId, key]) =>
    vscode.commands.registerCommand(commandId, (node?: DownloadNode) => {
      if (node?.row.name) handlers[key](node.row.name);
    }),
  );
}

/** The clicked row plus its multi-selection, collapsed to the row-name set a batch command
 *  acts on. Falls back to the clicked row alone when no selection array is passed (a host
 *  that doesn't supply one, or a single-row click). */
function selectionNames(clicked: DownloadNode | undefined, selected: DownloadNode[] | undefined): string[] {
  if (selected && selected.length > 0) return selected.map((n) => n.row.name);
  return clicked ? [clicked.row.name] : [];
}

/** Register Delete / Hide / Unhide — act on the WHOLE selection, not just the clicked row
 *  (#233). Hide/Unhide are idempotent per row (buildRowActionHandlers' hide/unhide always
 *  write `removed=true/false` regardless of prior state), so a mixed hidden/visible selection
 *  never errors — the `when` clause gating Hide vs Unhide can only inspect the clicked row, so
 *  a mixed selection applies whichever action that row's state offers to every selected row,
 *  matching MO2's own "Hide All". Delete gets its own batch-confirm entry point
 *  (`deleteArchives`) since one modal must cover the whole batch, never one per file. */
export function registerDownloadsMultiRowCommands(instanceRoot: string, log: (msg: string) => void): vscode.Disposable[] {
  const handlers = buildRowActionHandlers(instanceRoot, log);
  return [
    vscode.commands.registerCommand('modbench.downloads.delete', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      const names = selectionNames(clicked, selected);
      if (names.length > 0) void deleteArchives(instanceRoot, names, log);
    }),
    vscode.commands.registerCommand('modbench.downloads.hide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) handlers.hide(name);
    }),
    vscode.commands.registerCommand('modbench.downloads.unhide', (clicked?: DownloadNode, selected?: DownloadNode[]) => {
      for (const name of selectionNames(clicked, selected)) handlers.unhide(name);
    }),
  ];
}

// #238 slice 4: the view/title overflow (…) menu's Sort by… quick pick, plus the visible
// Show-hidden title-bar toggle. Both apply straight to DownloadsProvider (sortDownloadRows/
// filterHiddenRows are already applied inside its load()) — no row-level work, unlike the
// per-archive commands above, so these take the provider instead of instanceRoot/log.

/** The four sortable columns (`mo2/downloads.ts`' DownloadSortColumn), each offered in both
 *  directions — spec user story 8. Filetime desc (last) is the default DownloadsProvider
 *  already starts at, so leaving it unpicked here changes nothing. */
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

/** Register the Sort by… overflow command: a `showQuickPick` over the four sortable columns
 *  in both directions — native pick-one-of-N per modbench/CLAUDE.md, since a tree has no
 *  clickable column headers. Applies the pick straight to DownloadsProvider.setSort, which
 *  re-renders; Escape (undefined) is a silent no-op, matching switchProfile's own picker. */
export function registerDownloadsSortCommand(downloadsProvider: DownloadsProvider): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.downloads.sortBy', async () => {
    const picked = await vscode.window.showQuickPick(SORT_OPTIONS, { placeHolder: 'Sort downloads by' });
    if (!picked) return;
    downloadsProvider.setSort(picked.column, picked.descending);
  });
}

/** Register the Show/Hide-hidden title-bar toggle: the same two-command-one-context-key
 *  shape as the Mods tree's Sort Direction toggle (extension.ts' modbench.modList.view.winningAtTop/
 *  view.losingAtTop) — state lives on DownloadsProvider, the command handler owns the
 *  `modbench.downloads.showHidden` context key that package.json's `when` clauses gate on. */
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
