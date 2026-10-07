import * as vscode from 'vscode';

export function promptModName(
  defaultName: string, validateInput?: (value: string) => Thenable<string | undefined> | string | undefined,
): Thenable<string | undefined> {
  return vscode.window.showInputBox({ prompt: 'Mod name', value: defaultName, validateInput });
}
