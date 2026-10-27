import * as vscode from 'vscode';
import { gameFolderNotFoundLine } from './gameFolderNotFoundLog';
import { ErrorNode } from '../drivingLib/errorNode';
import { messageLine } from '../drivingLib/messageLine';
import { logOncePerFailure } from '../drivingLib/logOncePerFailure';
import { instanceMessages, type InstanceValue, type ProgramVersion, type InstanceView } from '../instanceLoader/instance';

export interface DeploymentFolderSetting {
  /** What VS Code holds of the setting. Only the workspace's value is an instance's deployment folder: a user-level value is every instance's. */
  inspect(): { workspaceValue?: string; globalValue?: string } | undefined;
  nameOf(path: string): string;
  changed(listener: () => void): vscode.Disposable;
}

type ToolboxDeps =
  | { instance: InstanceView; channel: Pick<vscode.LogOutputChannel, 'warn'>; deploymentFolder: DeploymentFolderSetting }
  | { instance: undefined };

const versionText = (version: ProgramVersion): string => {
  switch (version.kind) {
    case 'read': return version.version;
    case 'notFound': return 'none';
    case 'noVersionResource': return `${version.program} has no version resource`;
    case 'notAProgram': return `${version.program} is not a Windows program`;
    case 'unreadable': return `${version.program} cannot be read: ${version.why}`;
  }
};

const gameVersionText = (version: ProgramVersion): string =>
  (version.kind === 'notFound' ? `${version.program} not found` : versionText(version));

function foundTooltip(root: string, programVersions: InstanceValue['programVersions']): string {
  return programVersions.kind === 'found'
    ? [root, `Game: ${gameVersionText(programVersions.game)}`, `Script extender: ${versionText(programVersions.extender)}`].join('\n')
    : [root, 'Modbench knows no program of this game'].join('\n');
}

function gameRow(value: InstanceValue): vscode.TreeItem {
  const { gameName, gameFolder, programVersions } = value;
  const row = new vscode.TreeItem('Game');
  if (gameFolder.kind === 'found') {
    row.description = gameName;
    row.iconPath = new vscode.ThemeIcon('game');
    row.tooltip = foundTooltip(gameFolder.root, programVersions);
    return row;
  }
  // common.md, States, story 5: the name stays, and the warning rides beside it.
  row.description = `${gameName} · game folder not found`;
  row.iconPath = new vscode.ThemeIcon('warning');
  row.tooltip = [
    'Game folder not found. Modbench looked at:',
    ...gameFolder.looked.map(({ place, answer }) => `${place}: ${answer}`),
    `Set ${gameFolder.setting} to the game folder to fix it.`,
  ].join('\n');
  return row;
}

function profileRow({ activeProfile }: InstanceValue): vscode.TreeItem {
  const row = new vscode.TreeItem('Profile');
  row.description = activeProfile;
  row.iconPath = new vscode.ThemeIcon('account');
  row.tooltip = 'Switch profile';
  row.contextValue = 'profile';
  row.command = { command: 'modbench.profile.switch', title: 'Switch Profile' };
  return row;
}

function modlistRow({ holdsRepository }: InstanceValue): vscode.TreeItem {
  const row = new vscode.TreeItem('Modlist');
  row.iconPath = new vscode.ThemeIcon('source-control');
  row.contextValue = 'modlist';
  row.description = holdsRepository ? 'repository' : 'no repository';
  return row;
}

function deploymentRow(setting: DeploymentFolderSetting): vscode.TreeItem {
  const row = new vscode.TreeItem('Deployment');
  row.iconPath = new vscode.ThemeIcon('rocket');
  const folder = setting.inspect()?.workspaceValue;
  row.description = folder ? setting.nameOf(folder) : 'no deployment folder';
  row.tooltip = folder || undefined;
  row.command = { command: 'modbench.settings.openDeploymentFolderHere', title: 'Open Deployment Folder Setting' };
  return row;
}

/** A readout of the instance itself, one fact per row, read from the instance value alone
 *  (ADR-0015). */
export class ToolboxProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<undefined>();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly subscriptions: vscode.Disposable[];

  private gesture: string | undefined;

  constructor(private readonly deps: ToolboxDeps) {
    const changed = () => this._onDidChangeTreeData.fire(undefined);
    this.subscriptions = deps.instance
      ? [
        deps.instance.subscribe(changed), deps.instance.onReadFailure(changed),
        deps.deploymentFolder.changed(changed),
        logOncePerFailure(deps.instance, gameFolderNotFoundLine, (line) => deps.channel.warn(line)),
      ]
      : [];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /** What a gesture running says on the message line, until `undefined` gives the line back. */
  say(message: string | undefined): void {
    this.gesture = message;
    this._onDidChangeTreeData.fire(undefined);
  }

  viewMessage(): string | undefined {
    return this.gesture ?? (this.deps.instance && messageLine(...instanceMessages(this.deps.instance)));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element || !this.deps.instance) return [];
    const { instance, deploymentFolder } = this.deps;
    if (instance.sequence === 0) {
      return instance.readFailure === undefined ? [] : [new ErrorNode(instance.readFailure)];
    }
    return [gameRow(instance.value), profileRow(instance.value), modlistRow(instance.value), deploymentRow(deploymentFolder)];
  }
}
