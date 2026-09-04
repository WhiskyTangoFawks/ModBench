import * as vscode from 'vscode';

/** Home for actions scoped to the workspace, not one tree: VS Code's container-level `…` is an
 *  auto-generated Views menu, not a contribution point, so they need a view of their own.
 *  Injected getters keep both contexts' vocabulary out. */
export interface LoadoutHeaderDeps {
  /** False when there is no loadout. The view still registers then — it is the container's
   *  first view and must never be a hole — but the commands its rows activate do not exist. */
  hasLoadout: () => boolean;
  activeProfile: () => Promise<string | undefined>;
  deployment: () => Promise<'external' | 'deployed' | 'notDeployed'>;
}

// No command once deployed: Purge is destructive and belongs in overflow behind a modal confirm.
function deploymentRow(state: 'deployed' | 'notDeployed'): vscode.TreeItem {
  const deployed = state === 'deployed';
  const row = new vscode.TreeItem('Deployment');
  row.description = deployed ? 'deployed' : 'not deployed';
  row.iconPath = new vscode.ThemeIcon(deployed ? 'check' : 'circle-outline');
  if (!deployed) {
    row.tooltip = 'Deploy';
    row.command = { command: 'modbench.modList.deploy', title: 'Deploy' };
  }
  return row;
}

export class LoadoutHeaderProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: LoadoutHeaderDeps) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element || !this.deps.hasLoadout()) return [];
    const deployment = await this.deps.deployment();
    const rows = [await this.profileRow()];
    if (deployment !== 'external') rows.push(deploymentRow(deployment));
    return rows;
  }

  private async profileRow(): Promise<vscode.TreeItem> {
    const profile = await this.deps.activeProfile();
    const row = new vscode.TreeItem('Profile');
    row.description = profile ?? '—';
    row.iconPath = new vscode.ThemeIcon('account');
    row.tooltip = 'Switch profile';
    row.command = { command: 'modbench.modList.switchProfile', title: 'Switch Profile' };
    return row;
  }
}
