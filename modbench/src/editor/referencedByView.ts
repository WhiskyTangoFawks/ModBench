import * as vscode from 'vscode';
import {
  ReferencedByTreeProvider, type ReferencedByTreeNode, type ReferrerDirection,
} from './ReferencedByTreeProvider';

export function referencedByTitle(count: number | undefined): string {
  return count === undefined ? 'Referenced By' : `Referenced By (${count.toLocaleString()})`;
}

export interface ReferencedByFilter extends vscode.Disposable {
  setBaseDescription(text: string | undefined): void;
  refresh(): void;
  open(): void;
  clear(): void;
}

export interface ReferencedByFilterDeps {
  view: { description?: string; message?: string };
  object: string;
  placeholder: string;
  setFilter: (text: string, toggleOn: boolean) => void;
  hasRows: () => Promise<boolean>;
  termPlacement: 'afterBase';
  viewMessage: () => string | undefined;
  standingMessage: () => string | undefined;
  onRowsChanged: vscode.Event<unknown>;
}

function registerReferrerSortCommands(provider: Pick<ReferencedByTreeProvider, 'setDirection'>): vscode.Disposable[] {
  const show = (direction: ReferrerDirection) => {
    provider.setDirection(direction);
    void vscode.commands.executeCommand('setContext', 'modbench.referrer.descending', direction === 'descending');
  };
  void vscode.commands.executeCommand('setContext', 'modbench.referrer.descending', false);
  return [
    vscode.commands.registerCommand('modbench.referrer.sortAscending', () => show('ascending')),
    vscode.commands.registerCommand('modbench.referrer.sortDescending', () => show('descending')),
  ];
}

export interface ReferencedByView extends vscode.Disposable {
  provider: ReferencedByTreeProvider;
  view: vscode.TreeView<ReferencedByTreeNode>;
  filter: ReferencedByFilter;
}

export function createReferencedByView(
  client: ConstructorParameters<typeof ReferencedByTreeProvider>[0], log: (msg: string) => void,
  registerNameFilter: (deps: ReferencedByFilterDeps) => ReferencedByFilter,
): ReferencedByView {
  const provider = new ReferencedByTreeProvider(client, log);
  const view = vscode.window.createTreeView('modbench.referencedByTree', {
    treeDataProvider: provider,
    canSelectMany: true,
    showCollapseAll: true,
  });
  const filter = registerNameFilter({
    view,
    object: 'modbench.referrer',
    placeholder: 'Filter referrers…',
    setFilter: (text) => provider.setFilter(text),
    hasRows: () => provider.hasRows(),
    termPlacement: 'afterBase',
    viewMessage: () => provider.viewMessage(),
    standingMessage: () => provider.standingMessage(),
    onRowsChanged: provider.onDidChangeView,
  });
  const show = () => {
    view.title = referencedByTitle(provider.count());
    filter.setBaseDescription(provider.recordName());
  };
  show();
  filter.refresh();
  const disposable = vscode.Disposable.from(
    provider, view, filter, provider.onDidChangeView(show), ...registerReferrerSortCommands(provider));
  return { provider, view, filter, dispose: () => { disposable.dispose(); } };
}
