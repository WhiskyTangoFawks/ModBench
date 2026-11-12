import * as vscode from 'vscode';
import { isInsideAny } from './insideFolders';
import type { Instance } from '../instanceLoader/instance';

/** The folders of the workspace on disk. */
export const workspaceRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(({ uri }) => uri.scheme === 'file').map(({ uri }) => uri.fsPath);

export const inWorkspace = (path: string): boolean => isInsideAny(workspaceRoots(), path);

/** The game folder's archives take part in symbol resolution only inside the workspace, so the instance reads again when
 *  the workspace takes the game folder in or lets it go. */
export function refreshWhenGameFolderEntersOrLeavesWorkspace(own: (disposable: vscode.Disposable) => unknown, instance: Pick<Instance, 'value' | 'refresh'>): void {
  const holdsGameFolder = (): boolean => {
    const { gameFolder } = instance.value;
    return gameFolder.kind === 'found' && inWorkspace(gameFolder.dataFolder);
  };
  let held = holdsGameFolder();
  own(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    const now = holdsGameFolder();
    if (now !== held) void instance.refresh();
    held = now;
  }));
}
