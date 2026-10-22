import * as vscode from 'vscode';

// VS Code reads `key == false` as `!key`, which an unset key also satisfies, so the instance
// check's answer is a string and an unset key means the check has not run.
const FOLDER_KEY = 'modbench.folder';

type FolderCheck = 'instance' | 'untrustedInstance' | 'notAnInstance';

function answerInstanceCheck(root: string | undefined, isInstance: (root: string) => boolean, instance: Exclude<FolderCheck, 'notAnInstance'>): FolderCheck {
  const answer = root !== undefined && isInstance(root) ? instance : 'notAnInstance';
  void vscode.commands.executeCommand('setContext', FOLDER_KEY, answer);
  return answer;
}

const openRoot = (): string | undefined => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

export type OpenedFolder = { folder: 'instance'; instanceRoot: string } | { folder: 'notAnInstance' };

/** Outside an instance only the Toolbox registers, row-less, and each view's `viewsWelcome` says
 *  why. An instance whose files cannot be read is still an instance: its views show the error row
 *  (common.md, States, stories 2 and 4). */
export function openedFolder(isInstance: (root: string) => boolean, log: (message: string) => void): OpenedFolder {
  const root = openRoot();
  const folder = answerInstanceCheck(root, isInstance, 'instance');
  if (folder === 'instance' && root !== undefined) return { folder, instanceRoot: root };
  const what = root === undefined ? 'No folder is open' : `"${root}" is not an instance`;
  log(`[toolbox] ${what}; every view says how to open one.`);
  return { folder: 'notAnInstance' };
}

export function afterTrust(isInstance: (root: string) => boolean, start: () => void): vscode.Disposable {
  if (vscode.workspace.isTrusted) {
    start();
    return { dispose: () => undefined };
  }
  answerInstanceCheck(openRoot(), isInstance, 'untrustedInstance');
  return vscode.workspace.onDidGrantWorkspaceTrust(start);
}

export function whenOpened<T>(opened: OpenedFolder, on: { instance: (instanceRoot: string) => T; notAnInstance: () => T }): T {
  return opened.folder === 'instance' ? on.instance(opened.instanceRoot) : on.notAnInstance();
}
