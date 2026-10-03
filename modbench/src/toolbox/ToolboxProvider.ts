import * as vscode from 'vscode';
import { lastGoodReadMessage, type InstanceValue, type InstanceView } from '../instanceLoader/instance';

const MARK_DELAY_MS = 300;

export const UNCONFIRMED_TOOLTIP = 'Written; waiting for the disk to confirm';

interface UnconfirmedProfile {
  readonly name: string;
  marked: boolean;
  differedOnce: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ToolboxDeps {
  /** `undefined` with no instance open. The view still registers then — it is the container's
   *  first view and must never be a hole — but the commands its rows activate do not exist, so
   *  it renders no rows. */
  instance: InstanceView | undefined;
  /** One line to the Output. */
  log: (line: string) => void;
}

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

function profileRow({ activeProfile }: InstanceValue, unconfirmed: UnconfirmedProfile | undefined): vscode.TreeItem {
  const row = new vscode.TreeItem('Profile');
  row.description = unconfirmed?.name ?? activeProfile;
  row.iconPath = new vscode.ThemeIcon(unconfirmed?.marked ? 'sync~spin' : 'account');
  row.tooltip = unconfirmed?.marked ? UNCONFIRMED_TOOLTIP : 'Switch profile';
  row.contextValue = 'profile';
  row.command = { command: 'modbench.profile.switch', title: 'Switch Profile' };
  return row;
}

// The error row (common.md, States, story 2).
function failedReadRow(reason: string): vscode.TreeItem {
  const row = new vscode.TreeItem(`Failed to load: ${reason}`);
  row.tooltip = reason;
  row.iconPath = new vscode.ThemeIcon('error');
  return row;
}

/** A readout of the instance itself, one fact per row, read from the instance value alone
 *  (ADR-0015). */
export class ToolboxProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<undefined>();

  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly subscriptions: vscode.Disposable[];
  private unconfirmed?: UnconfirmedProfile;

  constructor(private readonly deps: ToolboxDeps) {
    const changed = () => this._onDidChangeTreeData.fire(undefined);
    this.subscriptions = deps.instance
      ? [deps.instance.subscribe((value) => { this.settleUnconfirmed(value); changed(); }), deps.instance.onReadFailure(changed)]
      : [];
  }

  private settleUnconfirmed({ activeProfile }: InstanceValue): void {
    const write = this.unconfirmed;
    if (write === undefined) return;
    if (activeProfile !== write.name && !write.differedOnce) {
      write.differedOnce = true;
      return;
    }
    if (activeProfile !== write.name) {
      this.deps.log(`Profile "${write.name}" was selected, and the disk now shows "${activeProfile}".`);
    }
    this.clearUnconfirmed();
  }

  /** The picked profile shows at once; the mark follows after a delay. */
  markUnconfirmedProfile(name: string): void {
    this.clearUnconfirmed();
    const write: UnconfirmedProfile = {
      name, marked: false, differedOnce: false,
      timer: setTimeout(() => {
        write.marked = true;
        this._onDidChangeTreeData.fire(undefined);
      }, MARK_DELAY_MS),
    };
    this.unconfirmed = write;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** A refused or failed switch shows the disk's profile at once, with no mark. */
  forgetUnconfirmedProfile(): void {
    this.clearUnconfirmed();
    this._onDidChangeTreeData.fire(undefined);
  }

  private clearUnconfirmed(): void {
    clearTimeout(this.unconfirmed?.timer);
    this.unconfirmed = undefined;
  }

  dispose(): void {
    this.clearUnconfirmed();
    for (const subscription of this.subscriptions) subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  viewMessage(): string | undefined {
    return this.deps.instance && lastGoodReadMessage(this.deps.instance);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const { instance } = this.deps;
    if (element || !instance) return [];
    if (instance.sequence === 0) {
      return instance.readFailure === undefined ? [] : [failedReadRow(instance.readFailure)];
    }
    return [gameRow(instance.value), profileRow(instance.value, this.unconfirmed)];
  }
}
