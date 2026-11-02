import * as vscode from 'vscode';

/** The path of the default script `name` that `folder` holds, none for a name that is not a file of the folder. */
export const defaultScriptIn = (folder: vscode.Uri) => async (name: string): Promise<string | undefined> =>
  (await vscode.workspace.fs.readDirectory(folder)).some(([entry]) => entry === `${name}.py`) ? vscode.Uri.joinPath(folder, `${name}.py`).fsPath : undefined;
