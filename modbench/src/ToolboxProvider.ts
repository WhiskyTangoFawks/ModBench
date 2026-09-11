import * as vscode from 'vscode';

/** The Instance fields the Toolbox's rows render (ADR-0015), and nothing else — MO2's top bar
 *  as a tree, reading the one read model. */
export interface ToolboxState {
  activeProfile: string;
  deployed: boolean;
}

/** Home for actions scoped to the workspace, not one tree: VS Code's container-level `…` is an
 *  auto-generated Views menu, not a contribution point, so they need a view of their own. */
export interface ToolboxDeps {
  /** `undefined` with no MO2 instance open. The view still registers then — it is the
   *  container's first view and must never be a hole — but the commands its rows activate do
   *  not exist, so it renders no rows. */
  state: () => ToolboxState | undefined;
}

// No command once deployed: Purge is destructive and belongs in overflow behind a modal confirm.
function deploymentRow(deployed: boolean): vscode.TreeItem {
  const row = new vscode.TreeItem('Deployment');
  row.description = deployed ? 'deployed' : 'not deployed';
  row.iconPath = new vscode.ThemeIcon(deployed ? 'check' : 'circle-outline');
  if (!deployed) {
    row.tooltip = 'Deploy';
    row.command = { command: 'modbench.modList.deploy', title: 'Deploy' };
  }
  return row;
}

// An unread instance names no profile yet, which reads as the same em-dash an unreadable one
// does: ADR-0019's background tier degrades a readout inline rather than toasting.
function profileRow(activeProfile: string): vscode.TreeItem {
  const row = new vscode.TreeItem('Profile');
  row.description = activeProfile || '—';
  row.iconPath = new vscode.ThemeIcon('account');
  row.tooltip = 'Switch profile';
  row.command = { command: 'modbench.modList.switchProfile', title: 'Switch Profile' };
  return row;
}

export class ToolboxProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<undefined>();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly deps: ToolboxDeps) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const state = element ? undefined : this.deps.state();
    if (!state) return [];
    return [profileRow(state.activeProfile), deploymentRow(state.deployed)];
  }
}
