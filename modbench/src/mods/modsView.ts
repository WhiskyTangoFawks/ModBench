import * as vscode from 'vscode';
import type { Instance, InstanceView } from '../instanceLoader/instance';
import type { ModCommands } from '../modCommands/modCommands';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import { sourceFiles } from '../instanceLoader/loadOrderSnapshot';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import type { NexusModRow } from '../drivingLib/inFocusedView';
import { errorMessage } from '../ports/errorMessage';
import { joinSyncMessages, messageLine, registerNameFilter, type NameFilter, type SyncMessage } from '../drivingLib/nameFilter';
import { registerSortDirectionToggle } from '../drivingLib/sortDirectionToggle';
import { modsKeyContext } from './gestureEntry';
import { onModCheckboxChanged } from './modCheckboxHandler';
import { ModListProvider, OverwriteNode, type ModlistNode } from './ModListProvider';
import { modNameOf } from '../instanceLoader/modName';
import { ModStatuses } from './modStatuses';
import type { MEditClient, ReadModStatus } from '../client';
import { registerModDecorations } from './modDecorations';
import { registerModInstallCommands } from './installCommands';
import { registerCompareFileCommand } from './compareFile';
import { registerGoToModCommand } from './goToMod';
import { registerBuildCommand } from './buildCommand';
import { BuildProblems } from './buildProblems';
import { registerDecompileAndCommitCommand } from './decompileAndCommitCommand';
import { registerManifestGestures, type ManifestGestureDeps } from './manifestGestures';
import { registerConflictTable } from './conflictTableEditor';
import { sameCopies, type CopyReads } from './sameCopies';
import {
  modsCopyValueText, registerCreateEmptyModCommand, registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands,
  registerModMoveCommand, registerOpenFolderCommand, registerOpenSourceCommand, registerSeparatorCommands, registerViewOnNexusCommand,
} from './modManagementCommands';

interface SourceGestureDeps {
  commands: SourceCommands;
  /** The rows of the focused Mods or Plugins view, which the palette's decompile and commit and build act on. */
  rows: () => readonly unknown[];
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
  /** The Plugins view's message line, where decompile and commit says its phase. */
  say: (message: string | undefined) => void;
  /** Saves a mod's unsaved plugin source; answers the paths VS Code left unsaved. */
  saveUnsavedPluginSource: (mod: string) => Promise<string[]>;
  /** Registers the source mods' repositories once a decompile and commit landed. */
  registerRepositories: () => Promise<void>;
}

type ManifestDeps = Pick<ManifestGestureDeps, 'commands' | 'toolboxView' | 'say' | 'focusedView'>;

interface ModsViewDeps {
  instance: InstanceView & Pick<Instance, 'refresh'>;
  commands: ModCommands;
  copyReads: CopyReads;
  log: (line: string) => void;
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionUri: vscode.Uri;
  warnIfFomod: (name: string, isFomod: boolean) => void;
  downloadInstall: Parameters<typeof registerModInstallCommands>[0]['downloadInstall'];
  /** The one selected mod row with a Nexus id in the focused Mods or Downloads view, for the palette. */
  nexusRow: () => NexusModRow | undefined;
  /** Mod sync, whose failure the view's message line says. */
  modSync: SyncMessage;
  sourceGestures: SourceGestureDeps;
  manifestGestures: ManifestDeps;
  /** Each mod's status: mEdit pushes the mods whose status changed, and the view reads them. */
  modStatus: { push: Pick<MEditClient, 'onNotification' | 'onReconnected'>; readStatus: ReadModStatus };
}

interface ModsView extends vscode.Disposable {
  view: vscode.TreeView<ModlistNode>;
  nameFilter: NameFilter;
  copyValue: CopyValueAdapter;
}

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModsView(deps: ModsViewDeps): ModsView {
  const { instance, commands, log, modSync, reporterFor, ask, trash } = deps;
  const { statuses, statusMessage } = modStatusesOf(deps);
  const provider = new ModListProvider({ instance, statuses });
  const view = vscode.window.createTreeView('modbench.modList', {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  const nameFilter = registerNameFilter({
    view,
    object: 'modbench.mod',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => provider.setFilter(text, grouping),
    hasRows: async () => (await provider.getChildren()).some((n) => !(n instanceof OverwriteNode) || n.lists()),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    termPlacement: 'afterBase',
    viewMessage: () => messageLine(provider.viewMessage(), modSync.message(), statusMessage()),
    standingMessage: () => provider.lastGoodReadMessage(),
    onRowsChanged: provider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => joinSyncMessages(modSync, statuses).onMessageChanged(listener),
  });
  const showCount = () => nameFilter.setBaseDescription(provider.description());
  showCount();
  const showBadge = () => { view.badge = provider.badge(); };
  nameFilter.refresh();
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(modsKeyContext(view.selection, (row) => provider.isEnabled(row)))) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, value);
    }
  };
  showKeyContext();
  const expand = () => void expandFilteredRows(view, provider, log);
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    provider.onDidChangeTreeData(showCount),
    provider.onDidChangeTreeData(showBadge),
    view.onDidChangeSelection(showKeyContext),
    provider.onDidChangeTreeData(showKeyContext),
    provider.onDidChangeTreeData(expand),
    view.onDidChangeVisibility(expand),
    view.onDidChangeCheckboxState(onModCheckboxChanged),
    ...registerModDecorations(instance, vscode.workspace, view),
    ...registerModContextCommands({
      commands, instance, viewSelection: () => view.selection, reporter: reporterFor('mod.uninstall'), ask, trash,
      log,
    }),
    ...registerSourceGestures(deps, provider),
    ...registerManifestGestures({ ...deps.manifestGestures, instance, reporter: reporterFor('modlist'), ask }),
    ...registerModEnableCommands(commands, instance, () => view.selection, reporterFor('mod.enableDisable')),
    ...registerFileExclusionCommands(commands, instance, () => view.selection, reporterFor('mod.excludeFile')),
    registerModMoveCommand(
      commands, instance, { selection: () => view.selection, direction: () => provider.viewDirection() }, reporterFor('mod.move')),
    ...registerSeparatorCommands(commands, instance, reporterFor('separator'), ask, trash, () => view.selection),
    registerCreateEmptyModCommand(commands, instance, reporterFor('mod.createEmpty')),
    registerOpenFolderCommand(instance, reporterFor('mod.openFolder'), () => view.selection),
    registerOpenSourceCommand(instance, reporterFor('mod.openSource'), () => view.selection),
    registerGoToModCommand(instance, reporterFor('mod.goToMod'), {
      selection: () => view.selection,
      rowFor: (origin) => provider.rowFor(origin),
      reveal: (row) => view.reveal(row, { select: true, focus: true }),
    }),
    registerCompareFileCommand(instance, reporterFor('mod.compareFile'), () => view.selection),
    ...registerConflictTable(instance, (files) => sameCopies(deps.copyReads, files), deps.extensionUri, () => view.selection, reporterFor('mod.openConflicts'), vscode.workspace),
    ...registerModInstallCommands({
      commands, instance, reporterFor, warnIfFomod: deps.warnIfFomod, downloadInstall: deps.downloadInstall,
    }),
    registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), deps.nexusRow),
    ...registerSortDirectionToggle('mod', provider),
    nameFilter,
    view,
    provider,
    statuses,
  );
  return {
    view, nameFilter, copyValue: { text: modsCopyValueText(() => view.selection), reporterTag: 'mod.copyValue' },
    dispose: () => { disposable.dispose(); },
  };
}

function registerSourceGestures(
  { instance, reporterFor, sourceGestures }: ModsViewDeps, provider: ModListProvider,
): vscode.Disposable[] {
  const showAnySource = () => { void vscode.commands.executeCommand('setContext', 'modbench.mod.anySource', instance.value.sourceMods.size > 0); };
  showAnySource();
  const problems = new BuildProblems(vscode.languages.createDiagnosticCollection('modbench-build'));
  const { commands, rows, pluginsView, say, saveUnsavedPluginSource, registerRepositories } = sourceGestures;
  const owner = (origin: string) => modOfOrigin(instance.value, origin)?.name;
  return [
    registerDecompileAndCommitCommand({
      progress: { say }, instance, commands, reporter: reporterFor('mod.decompileAndCommit'), onCommitted: registerRepositories,
      modOfOrigin: owner, pluginsView,
    }, rows),
    registerBuildCommand({
      commands, instance, gameRelease: () => instance.value.gameRelease, reporter: reporterFor('mod.build'), problems,
      sourceFiles: (origin) => sourceFiles(instance.value, origin), saveUnsaved: saveUnsavedPluginSource,
      modOfOrigin: owner, sourceDirs: () => instance.value.paths.sourceDirs, pluginsView,
    }, rows),
    provider.onDidChangeTreeData(showAnySource),
    problems,
  ];
}

// modlist-repository.md, Status, story 1: status shows while the instance holds a repository.
function modStatusesOf({ instance, modStatus, log }: Pick<ModsViewDeps, 'instance' | 'modStatus' | 'log'>) {
  const statuses = new ModStatuses(
    modStatus.push, modStatus.readStatus, log, () => instance.value.mods.flatMap((entry) => modNameOf(instance.value.modNames, entry) ?? []));
  return { statuses, statusMessage: () => (instance.value.holdsRepository ? statuses.message() : undefined) };
}

// VS Code keeps the expansion it remembers for a known row identity over the provider's state, so
// only a reveal opens a row the filter shows for its matches. A reveal also opens a hidden view.
async function expandFilteredRows(
  view: vscode.TreeView<ModlistNode>, provider: ModListProvider, log: (line: string) => void, parent?: ModlistNode,
): Promise<void> {
  if (!view.visible) return;
  for (const row of await provider.getChildren(parent)) {
    if (row.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) continue;
    try {
      await view.reveal(row, { select: false, focus: false, expand: true });
    } catch (e) {
      log(`Could not expand "${typeof row.label === 'string' ? row.label : row.id}" for the filter: ${errorMessage(e)}`);
      continue;
    }
    await expandFilteredRows(view, provider, log, row);
  }
}
