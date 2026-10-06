import * as vscode from 'vscode';

// VS Code's openWith also takes `background`, which opens a tab without making it its group's active one.
export type TabShowOptions = vscode.TextDocumentShowOptions & { background?: boolean };

/** Opens what `open` shows in `replaced`'s place: its group, its position, and its preview or pinned
 *  state (editor.md, Columns, story 8). */
export async function inTabsPlace(replaced: vscode.Tab, open: (options: TabShowOptions) => Promise<void>): Promise<void> {
  const { group } = replaced;
  await open({ viewColumn: group.viewColumn, preview: replaced.isPreview });
  // A preview opened over a preview has taken its place already; the same document is still it.
  const position = group.tabs.indexOf(replaced);
  if (position < 0 || group.activeTab === replaced) return;
  // A move takes the tab out before it puts it back, so at the replaced tab's index it lands beside it.
  await vscode.commands.executeCommand('moveActiveEditor', { to: 'position', by: 'tab', value: position + 1 });
  await vscode.window.tabGroups.close(replaced);
}

/** Opens what `open` shows in `replaced`'s stead as VS Code's rename of a file leaves its tab: in its
 *  group, its group's active tab or not, and the focus where it was. */
export async function inTabsStead(replaced: vscode.Tab, open: (options: TabShowOptions) => Promise<void>): Promise<void> {
  const { group } = replaced;
  // No command moves a tab that is not active, so an inactive one opens beside its group's active tab.
  await open({ viewColumn: group.viewColumn, preview: replaced.isPreview, preserveFocus: true, background: true });
  if (group.tabs.includes(replaced)) await vscode.window.tabGroups.close(replaced, true);
}
