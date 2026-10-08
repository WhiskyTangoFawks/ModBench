import * as vscode from 'vscode';

// VS Code's openWith also takes `background`, which opens a tab without making it its group's active one.
export type TabShowOptions = vscode.TextDocumentShowOptions & { background?: boolean };

/** Opens what `open` shows in `replaced`'s stead as VS Code's rename of a file leaves its tab: in its
 *  group, its group's active tab or not, and the focus where it was. */
export async function inTabsStead(replaced: vscode.Tab, open: (options: TabShowOptions) => Promise<void>): Promise<void> {
  const { group } = replaced;
  // No command moves a tab that is not active, so an inactive one opens beside its group's active tab.
  await open({ viewColumn: group.viewColumn, preview: replaced.isPreview, preserveFocus: true, background: true });
  if (group.tabs.includes(replaced)) await vscode.window.tabGroups.close(replaced, true);
}
