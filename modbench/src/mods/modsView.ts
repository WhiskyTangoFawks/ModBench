import * as vscode from 'vscode';
import type { Instance, InstanceView } from '../instanceLoader/instance';
import type { ModCommands } from '../modCommands/modCommands';
import type { SourceCommands } from '../sourceCommands/sourceCommands';
import { sourceFiles } from '../instanceLoader/loadOrderSnapshot';
import { modOfOrigin } from '../instanceLoader/modOfOrigin';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import type { DrawsHighlight, RelatesRows } from '../drivingLib/highlightFollowsFocus';
import { pluginsHeld } from './pluginsHeld';
import type { CopyValueAdapter } from '../drivingLib/copyValue';
import { nexusRowInFocusedView, selectionInFocusedView } from '../drivingLib/inFocusedView';
import type { FocusedView } from '../drivingLib/focusedView';
import { errorMessage } from '../ports/errorMessage';
import { registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import { linesOf, messageLine } from '../drivingLib/messageLine';
import { joinSyncMessages, type SyncMessage } from '../drivingLib/syncFailureReport';
import { registerSortDirectionToggle } from '../drivingLib/sortDirectionToggle';
import { MODS_KEY_ARGS, modsKeyContext } from './gestureEntry';
import { publisherKeyContext, registerPublisherTagCommands } from './publisherTagCommands';
import { onModCheckboxChanged } from './modCheckboxHandler';
import { ModListProvider, OverwriteNode, type ModlistNode } from './ModListProvider';
import type { ModStatuses } from '../modStatus/modStatuses';
import { registerModDecorations } from './modDecorations';
import { OpenRows } from './openRows';
import { registerModInstallCommands } from './installCommands';
import { fomodDialog } from './fomodDialog';
import { registerCompareFileCommand } from './compareFile';
import { registerGoToModCommand } from './goToMod';
import { registerBuildCommand } from './buildCommand';
import { publishBuildTargets } from './buildTargets';
import { registerBuildTask } from './buildTask';
import { BuildProblems } from './buildProblems';
import { ModProblems } from './modProblems';
import { PublisherProblems } from './publisherProblems';
import { registerInitSourceModCommand } from './initSourceModCommand';
import { registerManifestGestures, type ManifestGestureDeps } from './manifestGestures';
import { registerCheckForUpdatesGestures, type CheckForUpdatesDeps } from './checkForUpdatesGestures';
import type { CheckForUpdates } from '../modCommands/checkForUpdates';
import { registerConflictTable } from './conflictTableEditor';
import { sameCopies, type CopyReads } from '../drivingLib/sameCopies';
import {
  modsCopyValueText, registerCreateEmptyModCommand, registerFileExclusionCommands, registerModContextCommands, registerModEnableCommands,
  registerModMoveCommand, registerOpenFolderCommand, registerOpenSourceCommand, registerSeparatorCommands, registerViewOnNexusCommand,
} from './modManagementCommands';

interface SourceGestureDeps {
  commands: SourceCommands;
  /** The Plugins view's id, whose bar a gesture from a plugin row runs under. */
  pluginsView: string;
  /** The Plugins view's message line, where init source mod says its phase when fired from there. */
  say: (message: string | undefined) => void;
  /** Registers the source mods' repositories once an init source mod landed. */
  registerRepositories: () => Promise<void>;
}

type ManifestDeps = Pick<ManifestGestureDeps, 'commands' | 'toolboxView' | 'say'>;

interface ModsViewDeps {
  instance: InstanceView & Pick<Instance, 'refresh' | 'quiet'>;
  commands: ModCommands;
  copyReads: CopyReads;
  channel: { warn(line: string): void };
  reporterFor: (tag: string) => Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  extensionUri: vscode.Uri;
  /** The Downloads view's id, whose bar an install from a downloaded file runs under, and whose selected row the palette's view on Nexus can act on. */
  downloadsView: string;
  focusedView: FocusedView;
  /** Mod sync, whose failure the view's message line says. */
  modSync: SyncMessage;
  sourceGestures: SourceGestureDeps;
  manifestGestures: ManifestDeps;
  checkForUpdates: CheckForUpdates;
  /** Each mod's status, as mEdit last answered it. */
  statuses: ModStatuses;
}

const checkForUpdatesDeps = (
  { checkForUpdates, focusedView }: ModsViewDeps, instance: Pick<Instance, 'value' | 'refresh' | 'quiet'>, reporter: Reporter,
): CheckForUpdatesDeps => ({ commands: { checkForUpdates }, instance, reporter, focusedView });

interface ModsView extends vscode.Disposable {
  view: vscode.TreeView<ModlistNode>;
  nameFilter: NameFilter;
  copyValue: CopyValueAdapter;
  relatesRows: RelatesRows;
  drawsHighlight: DrawsHighlight;
  /** The lines the view's message line shows, for the agent. */
  messages(): string[];
}

/** Tree, filter and count readout together, because the view's description and message line
 *  each have exactly one owner. Split apart, a row change and a filter keystroke race for them and
 *  the loser silently vanishes. */
export function createModsView(deps: ModsViewDeps): ModsView {
  const { instance, commands, channel, modSync, reporterFor, ask, trash, statuses, focusedView } = deps;
  const log = (line: string): void => { channel.warn(`[modList] ${line}`); };
  const downloadedFileInstallReporting = {
    reporter: reporterFor('downloadedFiles'), log: (line: string) => { channel.warn(`[downloadedFiles] ${line}`); }, progressViewId: deps.downloadsView,
  };
  const owned: vscode.Disposable[] = [];
  const own = <T extends vscode.Disposable>(disposable: T): T => { owned.push(disposable); return disposable; };
  const nexusRow = nexusRowInFocusedView(own, focusedView, [MODS_KEY_ARGS.view, deps.downloadsView], 'modbench.mod.nexusRowIn');
  const sourceGestureRows = selectionInFocusedView(own, focusedView, [MODS_KEY_ARGS.view, deps.sourceGestures.pluginsView], 'modbench.mod.sourceGestureRowsIn');
  const statusMessage = () => (instance.value.holdsRepository ? statuses.message() : undefined); // modlist-repository.md, Status, story 1
  const open = new OpenRows(instance);
  const provider = new ModListProvider({ instance, statuses, open, reporter: reporterFor('modlist.drop') });
  const view = vscode.window.createTreeView(MODS_KEY_ARGS.view, {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
    dragAndDropController: provider,
  });
  let phaseMessage: string | undefined;
  const viewMessage = () => messageLine(provider.viewMessage(), phaseMessage, modSync.message(), statusMessage());
  const nameFilter = registerNameFilter({
    view,
    object: 'modbench.mod',
    placeholder: 'Filter mods…',
    setFilter: (text, grouping) => provider.setFilter(text, grouping),
    hasRows: async () => (await provider.getChildren()).some((n) => !(n instanceof OverwriteNode) || n.lists()),
    toggle: { icon: 'list-tree', label: 'Group by separator' },
    termPlacement: 'afterBase',
    viewMessage,
    standingMessage: () => provider.standingMessage(),
    onRowsChanged: provider.onDidChangeTreeData,
    onViewMessageChanged: (listener) => joinSyncMessages(modSync, statuses).onMessageChanged(listener),
  });
  const sayPhase = (message: string | undefined) => { phaseMessage = message; nameFilter.refresh(); };
  const showCount = () => nameFilter.setBaseDescription(provider.description());
  showCount();
  const showBadge = () => { view.badge = provider.badge(); };
  nameFilter.refresh();
  const showKeyContext = () => {
    for (const [name, value] of Object.entries({
      ...modsKeyContext(view.selection, (row) => provider.isEnabled(row)), ...publisherKeyContext(instance.value, view.selection),
    })) {
      void vscode.commands.executeCommand('setContext', `modbench.mod.${name}`, value);
    }
  };
  showKeyContext();
  let walks = 0;
  const expand = () => {
    const walk = ++walks;
    void expandFilteredRows(view, provider, log, () => walk !== walks);
  };
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    ...owned,
    provider.onDidChangeTreeData(showCount),
    provider.onDidChangeTreeData(showBadge),
    view.onDidChangeSelection(showKeyContext),
    provider.onDidChangeTreeData(showKeyContext),
    provider.onDidChangeTreeData(expand),
    view.onDidChangeVisibility(expand),
    view.onDidChangeCheckboxState(onModCheckboxChanged),
    view.onDidExpandElement(({ element }) => { if (element.resourceUri) open.expandedRow(element.resourceUri); }),
    view.onDidCollapseElement(({ element }) => { if (element.resourceUri) open.collapsedRow(element.resourceUri); }),
    ...registerModDecorations(instance, open, vscode.workspace),
    new PublisherProblems(vscode.languages.createDiagnosticCollection('modbench-publisher'), instance),
    new ModProblems(vscode.languages.createDiagnosticCollection('modbench-mod-status'), instance, statuses),
    ...registerModContextCommands({
      commands, instance, viewSelection: () => view.selection, reporter: reporterFor('mod.uninstall'), ask, trash,
      log,
    }),
    ...registerSourceGestures(deps, provider, sourceGestureRows, sayPhase),
    ...registerManifestGestures({ ...deps.manifestGestures, focusedView, instance, reporter: reporterFor('modlist') }),
    ...registerCheckForUpdatesGestures(checkForUpdatesDeps(deps, instance, reporterFor('mod.checkForUpdates'))),
    ...registerModEnableCommands(commands, instance, () => view.selection, reporterFor('mod.enableDisable')),
    ...registerFileExclusionCommands(commands, instance, () => view.selection, reporterFor('mod.excludeFile')),
    ...registerPublisherTagCommands(commands, instance, () => view.selection, reporterFor('mod.publisherTag')),
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
      commands, instance, reporterFor, trash, fomodDialog: (progress) => fomodDialog(deps.extensionUri, ask, progress), downloadedFileInstallReporting,
    }),
    registerViewOnNexusCommand(instance, reporterFor('mod.viewOnNexus'), nexusRow),
    ...registerSortDirectionToggle('mod', provider),
    nameFilter,
    view,
    provider,
    open,
  );
  return {
    view, nameFilter, copyValue: { text: modsCopyValueText(() => view.selection), reporterTag: 'mod.copyValue' },
    relatesRows: { related: (selection) => ({ plugins: pluginsHeld(instance.value, selection), origins: [] }) },
    drawsHighlight: { highlight: (related) => { provider.highlight(related.origins); } },
    messages: () => linesOf(viewMessage()),
    dispose: () => { disposable.dispose(); },
  };
}

function registerSourceGestures(
  { instance, reporterFor, sourceGestures }: ModsViewDeps, provider: ModListProvider, rows: () => readonly unknown[],
  sayInMods: (message: string | undefined) => void,
): vscode.Disposable[] {
  const showAnySource = () => {
    void vscode.commands.executeCommand('setContext', 'modbench.mod.anySource', instance.value.sourceMods.size > 0);
    publishBuildTargets(instance.value.paths.sourceDirs);
  };
  showAnySource();
  const problems = new BuildProblems(vscode.languages.createDiagnosticCollection('modbench-build'), instance);
  const { commands, pluginsView, say, registerRepositories } = sourceGestures;
  const owner = (origin: string) => modOfOrigin(instance.value, origin)?.name;
  return [
    registerInitSourceModCommand({
      progressIn: (view) => ({ say: view === MODS_KEY_ARGS.view ? sayInMods : say }), instance, commands, reporter: reporterFor('mod.initSourceMod'), onCommitted: registerRepositories,
      modOfOrigin: owner, pluginsView,
    }, rows),
    registerBuildCommand({
      commands, instance, reporter: reporterFor('mod.build'), problems,
      sourceFiles: (origin) => sourceFiles(instance.value, origin),
      modOfOrigin: owner, sourceDirs: () => instance.value.paths.sourceDirs, pluginsView,
    }, rows),
    registerBuildTask(reporterFor('mod.build')),
    provider.onDidChangeTreeData(showAnySource),
    problems,
  ];
}

// VS Code keeps a known row's expansion, so only a reveal opens a filtered row, and it opens a
// hidden view. VS Code cannot resolve a row of a changed tree, so a newer walk supersedes this one.
function expandFilteredRows(
  view: vscode.TreeView<ModlistNode>, provider: ModListProvider, log: (line: string) => void, superseded: () => boolean,
): Promise<void> {
  const walk = async (parent?: ModlistNode): Promise<void> => {
    for (const row of await provider.getChildren(parent)) {
      if (superseded()) return;
      if (row.collapsibleState !== vscode.TreeItemCollapsibleState.Expanded) continue;
      try {
        await view.reveal(row, { select: false, focus: false, expand: true });
      } catch (e) {
        if (superseded()) return;
        log(`Could not expand "${typeof row.label === 'string' ? row.label : row.id}" for the filter: ${errorMessage(e)}`);
        continue;
      }
      await walk(row);
    }
  };
  return view.visible ? walk() : Promise.resolve();
}
