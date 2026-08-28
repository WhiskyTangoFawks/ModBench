import * as vscode from 'vscode';

/** #247: the Loadout header — a small readout pinned above the domain trees, and the home
 *  for every action whose scope is the workspace rather than one tree (profile, deployment).
 *  It exists because roughly half the icons the trees had grown were not about those trees at
 *  all; the rubric's first rule ("scope first") needs somewhere for them to go, and VS Code's
 *  container-level `…` is its own auto-generated Views menu, not a contribution point.
 *
 *  #352: the editing session (Launch/Close mEdit) moved off this header onto the Plugins view
 *  — the maintainer's ruling was that mEdit is an option on Plugins, not a workspace action —
 *  so this view no longer reads backend/session state at all.
 *
 *  Lives at the composition root, not in either bounded context: it reads a Mod-Management
 *  readout, so importing either context's internals would put the language boundary inside
 *  one file. State arrives as injected getters instead — the same constraint #241 recorded
 *  for the merged plugins provider. */
export interface LoadoutHeaderDeps {
  /** False when there is no loadout at all — no workspace open, or one that isn't an MO2
   *  instance. The view still registers on those paths (it is the container's first view and
   *  must never be a hole), but the commands its rows activate are registered alongside the
   *  Loadout views and so do not exist, which would make every row throw on click. */
  hasLoadout: () => boolean;
  activeProfile: () => Promise<string | undefined>;
  deployment: () => Promise<'external' | 'deployed' | 'notDeployed'>;
}

/** The deployment readout, contributed only when Modbench itself is the deployer. Not
 *  deployed offers Deploy; deployed is a readout with no command — Purge is destructive, and
 *  the rubric keeps destructive actions in overflow behind a modal confirm rather than one
 *  click away on a row the user is reading. */
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
