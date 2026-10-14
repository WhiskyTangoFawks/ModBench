import * as vscode from 'vscode';
import { gameFolderNotFoundLine } from './gameFolderNotFoundLog';
import { ErrorNode } from '../drivingLib/errorNode';
import { logOncePerFailure } from '../drivingLib/logOncePerFailure';
import { lastGoodReadMessage, type InstanceValue, type InstanceView } from '../instanceLoader/instance';

type ToolboxDeps =
  | { instance: InstanceView; channel: Pick<vscode.LogOutputChannel, 'warn'> }
  | { instance: undefined };

function gameRow({ gameName, gameFolder }: InstanceValue): vscode.TreeItem {
  const row = new vscode.TreeItem('Game');
  if (gameFolder.kind === 'found') {
    row.description = gameName;
    row.iconPath = new vscode.ThemeIcon('game');
    row.tooltip = gameFolder.root;
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
  if (holdsRepository) {
    row.description = 'repository';
    return row;
  }
  row.description = 'no repository';
  row.tooltip = 'Git init';
  row.command = { command: 'modbench.modlist.gitInit', title: 'Git Init Modlist' };
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
    return this.gesture ?? (this.deps.instance && lastGoodReadMessage(this.deps.instance));
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const { instance } = this.deps;
    if (element || !instance) return [];
    if (instance.sequence === 0) {
      return instance.readFailure === undefined ? [] : [new ErrorNode(instance.readFailure)];
    }
    return [gameRow(instance.value), profileRow(instance.value), modlistRow(instance.value)];
  }
}
