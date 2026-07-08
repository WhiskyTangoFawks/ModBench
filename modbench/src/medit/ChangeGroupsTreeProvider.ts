import * as vscode from 'vscode';
import type { ApiClient } from './ApiClient';
import type { components } from './generated/api';

type ChangeGroup = components['schemas']['ChangeGroup'];

export class ChangeGroupNode extends vscode.TreeItem {
  readonly groupId: string;
  constructor(group: ChangeGroup) {
    const op = group.operation ?? '';
    const label = group.description ? `${op} — ${group.description}` : op;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.groupId = group.id ?? '';
    this.description = `${group.changeCount ?? 0} changes · ${group.pluginCount ?? 0} plugins`;
    this.contextValue = 'changeGroup';
  }
}

export class EmptyStateNode extends vscode.TreeItem {
  constructor() {
    super('No pending group changes.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('check');
  }
}

export type ChangeGroupTreeNode = ChangeGroupNode | EmptyStateNode;

export class ChangeGroupsTreeProvider implements vscode.TreeDataProvider<ChangeGroupTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ChangeGroupTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _groups: ChangeGroup[] = [];
  private readonly log: (msg: string) => void;

  constructor(private readonly client: ApiClient, log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ChangeGroupTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ChangeGroupTreeNode[]> {
    const { data, response } = await this.client.GET('/change-groups', {});
    if (!response.ok || !Array.isArray(data)) {
      this.log(`[ChangeGroupsTreeProvider] fetch failed (${response.status})`);
      this._groups = [];
      return [new EmptyStateNode()];
    }
    this._groups = data;
    if (this._groups.length === 0) return [new EmptyStateNode()];
    return this._groups.map(g => new ChangeGroupNode(g));
  }
}
