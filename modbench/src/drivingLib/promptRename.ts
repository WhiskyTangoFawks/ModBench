import * as vscode from 'vscode';

/** The new name for a row, prefilled with the current one; undefined on Esc, an empty name or the same name. */
export async function promptRename(
  prompt: string, oldName: string, validateInput: NonNullable<vscode.InputBoxOptions['validateInput']>,
): Promise<string | undefined> {
  const newName = await vscode.window.showInputBox({ prompt, value: oldName, validateInput });
  return !newName || newName === oldName ? undefined : newName;
}
