import { vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri, type FakeUri,
} from '../../test/vscodeMock';
import { recordedWithProgress } from '../../test/recordedProgress';
import { filterBoxWindowMock, filterBoxCommandsMock, FakeTreeViews, type FakeInputBox } from '../../drivingLib/test/nameFilterViewHarness';

/** What the Downloads view registered and set: its commands, its context keys and its name filter's boxes. */
export const registered = {
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  contextKeys: new Map<string, unknown>(),
  boxes: [] as FakeInputBox[],
  decorationProviders: [] as vscode.FileDecorationProvider[],
};

export const treeViews = new FakeTreeViews();
export const openExternal = vi.fn<(uri: FakeUri) => Promise<boolean>>();
export const showTextDocument = vi.fn<(uri: FakeUri) => Promise<unknown>>();
export const createQuickPick = vi.fn();

/** The `vscode` module the Downloads view runs against; mock it with
 *  `vi.mock('vscode', async () => (await import('./downloadsVscode')).downloadsVscode())`. */
export const downloadsVscode = () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri,
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
  env: { openExternal },
  window: {
    ...filterBoxWindowMock(registered),
    withProgress: recordedWithProgress,
    showTextDocument,
    createQuickPick,
    createTreeView: (id: string, options: vscode.TreeViewOptions<unknown>) => treeViews.create(id, options),
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => {
      registered.decorationProviders.push(provider);
      return { dispose: () => undefined };
    },
  },
  commands: {
    ...filterBoxCommandsMock(registered),
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext' && typeof args[0] === 'string') registered.contextKeys.set(args[0], args[1]);
      return Promise.resolve();
    },
  },
});

export function clearRegistered(): void {
  registered.commands.clear();
  registered.contextKeys.clear();
  registered.boxes.length = 0;
  registered.decorationProviders.length = 0;
  treeViews.clear();
  vi.clearAllMocks();
}
