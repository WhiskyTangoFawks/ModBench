import * as vscode from 'vscode';
import type { Instance, InstanceView } from '../instanceLoader/instance';
import type { DownloadsCommands } from '../downloadsCommands/downloads';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import { registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import {
  registerDownloadsExcludedToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand,
} from './DownloadsPanel';
import { DownloadsProvider, type DownloadsTreeNode } from './DownloadsProvider';
import { ExcludedDownloadDecorationProvider } from './ExcludedDownloadDecorationProvider';
import { downloadsFolderUnresolvedLine } from './downloadsFolderUnresolvedLog';
import { logOncePerFailure } from '../drivingLib/logOncePerFailure';
import { downloadsKeyContext } from './keyContext';

interface DownloadsViewDeps {
  commands: DownloadsCommands;
  instance: InstanceView & Pick<Instance, 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  log: (line: string) => void;
  logUnresolved: (line: string) => void;
}

interface DownloadsView extends vscode.Disposable {
  provider: DownloadsProvider;
  view: vscode.TreeView<DownloadsTreeNode>;
  nameFilter: NameFilter;
}

/** Rows come from the Instance value alone (ADR-0015). */
export function createDownloadsView(
  { commands, instance, reporter, ask, trash, log, logUnresolved }: DownloadsViewDeps,
): DownloadsView {
  const provider = new DownloadsProvider({ instance }); // disposes its Instance subscriptions
  const view = vscode.window.createTreeView('modbench.downloads', {
    treeDataProvider: provider,
    canSelectMany: true,
  });
  // Dims excluded rows once Show excluded is on. VS Code never re-queries a decoration provider
  // on its own, so this refreshes it on every rows change — exclude, include and a disk edit alike.
  const excludedDecorations = new ExcludedDownloadDecorationProvider(
    () => instance.value.paths.downloadsDir, () => provider.excludedNames());
  const nameFilter = registerNameFilter({
    view, object: 'modbench.downloadedFile', placeholder: 'Filter downloads…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: async () => (await provider.getChildren()).length > 0,
    viewMessage: () => provider.viewMessage(),
    standingMessage: () => provider.viewMessage(),
    onRowsChanged: provider.onDidChangeTreeData,
  });
  // package.json's viewsWelcome gates the all-excluded message on this key (downloads.md,
  // States, story 2), recomputed on every row change so a disk edit reaches it too.
  const updateAllExcludedContext = () =>
    void vscode.commands.executeCommand('setContext', 'modbench.downloadedFile.allExcluded', provider.allExcluded());
  updateAllExcludedContext();
  const showKeyContext = () => {
    for (const [name, value] of Object.entries(downloadsKeyContext(view.selection))) {
      void vscode.commands.executeCommand('setContext', `modbench.downloadedFile.${name}`, value);
    }
  };
  showKeyContext();
  // Disposed in order: what reads the tree and the view goes before them.
  const disposable = vscode.Disposable.from(
    logOncePerFailure(instance, downloadsFolderUnresolvedLine, logUnresolved),
    vscode.window.registerFileDecorationProvider(excludedDecorations),
    provider.onDidChangeTreeData(() => excludedDecorations.refresh()),
    provider.onDidChangeTreeData(updateAllExcludedContext),
    view.onDidChangeSelection(showKeyContext),
    provider.onDidChangeTreeData(showKeyContext),
    registerDownloadsSortCommand(provider),
    ...registerDownloadsExcludedToggleCommands(provider),
    ...registerDownloadsSingleRowCommands(reporter, () => view.selection),
    ...registerDownloadsMultiRowCommands(commands, instance, reporter, ask, trash, log, () => view.selection),
    nameFilter,
    view,
    provider,
  );
  return {
    provider, view, nameFilter,
    dispose: () => { disposable.dispose(); },
  };
}
