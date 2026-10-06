import * as vscode from 'vscode';

/** Opens what `open` shows in `replaced`'s place: its group, its position, and its preview or pinned
 *  state (editor.md, Columns, story 8). */
export async function inTabsPlace(replaced: vscode.Tab, open: (options: vscode.TextDocumentShowOptions) => Promise<void>): Promise<void> {
  const { group } = replaced;
  await open({ viewColumn: group.viewColumn, preview: replaced.isPreview });
  // A preview opened over a preview has taken its place already; the same document is still it.
  const position = group.tabs.indexOf(replaced);
  if (position < 0 || group.activeTab === replaced) return;
  // A move takes the tab out before it puts it back, so at the replaced tab's index it lands beside it.
  await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
  await vscode.window.tabGroups.close(replaced);
}
