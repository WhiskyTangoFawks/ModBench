import * as vscode from 'vscode';

/** Opens what `open` shows in the active tab's place: its group, its position, and its preview or
 *  pinned state (editor.md, Columns, story 8). */
export async function inActiveTabsPlace(open: (options: vscode.TextDocumentShowOptions) => Promise<void>): Promise<void> {
  const group = vscode.window.tabGroups.activeTabGroup;
  const replaced = group.activeTab;
  if (!replaced) return open({ viewColumn: group.viewColumn });
  const position = group.tabs.indexOf(replaced);
  await open({ viewColumn: group.viewColumn, preview: replaced.isPreview });
  // A preview opened over a preview has taken its place already; the same document is still it.
  if (!group.tabs.includes(replaced) || group.activeTab === replaced) return;
  await vscode.window.tabGroups.close(replaced);
  await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
}
