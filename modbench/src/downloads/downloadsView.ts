import * as vscode from 'vscode';
import type { DownloadFile, Instance, InstanceView } from '../instanceLoader/instance';
import type { DownloadsAccess } from '../downloadsCommands/downloads';
import type { InstallAccess } from '../install/install';
import type { Reporter } from '../ports/reporter';
import type { AskQuestion } from '../ports/dialog';
import type { MoveToTrash } from '../ports/trash';
import { registerNameFilter, type NameFilter } from '../drivingLib/nameFilter';
import {
  installDownloadedFile, registerDownloadsExcludedToggleCommands, registerDownloadsMultiRowCommands,
  registerDownloadsSingleRowCommands, registerDownloadsSortCommand, type DownloadInstallDeps,
} from './DownloadsPanel';
import { DownloadsProvider, type DownloadsTreeNode } from './DownloadsProvider';
import { ExcludedDownloadDecorationProvider } from './ExcludedDownloadDecorationProvider';
import { downloadsFolderUnresolvedLine } from './downloadsFolderUnresolvedLog';
import { logOncePerFailure } from '../drivingLib/logOncePerFailure';
import { downloadsKeyContext } from './keyContext';

interface DownloadsViewDeps {
  access: DownloadsAccess & InstallAccess;
  instance: InstanceView & Pick<Instance, 'refresh'>;
  reporter: Reporter;
  ask: AskQuestion;
  trash: MoveToTrash;
  install: DownloadInstallDeps;
  logUnresolved: (line: string) => void;
}

export interface DownloadsView extends vscode.Disposable {
  provider: DownloadsProvider;
  view: vscode.TreeView<DownloadsTreeNode>;
  nameFilter: NameFilter;
  installDownloaded: (file: DownloadFile) => Promise<boolean>;
}

/** Rows come from the Instance value alone (ADR-0015). */
export function createDownloadsView(
  { access, instance, reporter, ask, trash, install, logUnresolved }: DownloadsViewDeps,
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
    ...registerDownloadsMultiRowCommands(access, instance, reporter, ask, trash, install.log, () => view.selection),
    nameFilter,
    view,
    provider,
  );
  return {
    provider, view, nameFilter,
    installDownloaded: (file) => installDownloadedFile(file, access, instance, reporter, install),
    dispose: () => { disposable.dispose(); },
  };
}
