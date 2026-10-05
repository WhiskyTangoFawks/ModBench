import * as vscode from 'vscode';

/** A pick that opens with one item marked, which `showQuickPick` cannot do. Esc yields `undefined`. */
export function pickWithMarked<T extends vscode.QuickPickItem>(
  items: readonly T[], marked: T | undefined, placeholder: string,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<T>();
    quickPick.items = items;
    quickPick.placeholder = placeholder;
    quickPick.activeItems = marked ? [marked] : [];
    let accepted = false;
    quickPick.onDidAccept(() => {
      accepted = true;
      const [picked] = quickPick.selectedItems;
      quickPick.hide();
      resolve(picked);
    });
    quickPick.onDidHide(() => {
      if (!accepted) resolve(undefined);
      quickPick.dispose();
    });
    quickPick.show();
  });
}
