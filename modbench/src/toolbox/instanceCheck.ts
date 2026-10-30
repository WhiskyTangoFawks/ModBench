import * as vscode from 'vscode';

// VS Code reads `key == false` as `!key`, which an unset key also satisfies, so the instance
// check's answer is a string and an unset key means the check has not run.
const FOLDER_KEY = 'modbench.folder';

type FolderCheck = 'instance' | 'untrustedInstance' | 'notAnInstance';

const openRoots = (): string[] => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];

function answerInstanceCheck(foundInstance: boolean, instance: Exclude<FolderCheck, 'notAnInstance'>): FolderCheck {
  const answer = foundInstance ? instance : 'notAnInstance';
  void vscode.commands.executeCommand('setContext', FOLDER_KEY, answer);
  return answer;
}

export type OpenedFolder = { folder: 'instance'; instanceRoot: string } | { folder: 'notAnInstance' };

/** Outside an instance only the Toolbox registers, row-less, and each view's `viewsWelcome` says
 *  why. An instance whose files cannot be read is still an instance: its views show the error row
 *  (common.md, States, story 2). */
export function openedFolder(isInstance: (root: string) => boolean, log: (message: string) => void): OpenedFolder {
  const roots = openRoots();
  const [chosen, ...others] = roots.filter(isInstance);
  answerInstanceCheck(chosen !== undefined, 'instance');
  if (chosen !== undefined) {
    for (const other of others) log(`[toolbox] "${other}" is also an instance; this window opens "${chosen}".`);
    return { folder: 'instance', instanceRoot: chosen };
  }
  const what = roots.length === 0 ? 'No folder is open' : 'No open folder is an instance';
  log(`[toolbox] ${what}; every view says how to open one.`);
  return { folder: 'notAnInstance' };
}

export function afterTrust(isInstance: (root: string) => boolean, start: () => void): vscode.Disposable {
  if (vscode.workspace.isTrusted) {
    start();
    return { dispose: () => undefined };
  }
  answerInstanceCheck(openRoots().some(isInstance), 'untrustedInstance');
  return vscode.workspace.onDidGrantWorkspaceTrust(start);
}

export function whenOpened<T>(opened: OpenedFolder, on: { instance: (instanceRoot: string) => T; notAnInstance: () => T }): T {
  return opened.folder === 'instance' ? on.instance(opened.instanceRoot) : on.notAnInstance();
}
