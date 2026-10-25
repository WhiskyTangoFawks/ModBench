import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, Uri,
} from '../../test/vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, commandInvoker, currentBoxOf, FakeTreeViews,
} from '../../drivingLib/test/nameFilterViewHarness';

const h = vi.hoisted(() => ({
  state: {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, unknown>(),
    boxes: [],
  },
  decorationProviders: [] as vscode.FileDecorationProvider[],
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri,
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: vscode.TreeDataProvider<unknown> }) => treeViews.create(id, options),
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => {
      h.decorationProviders.push(provider);
      return { dispose: () => undefined };
    },
  },
  commands: {
    ...filterBoxCommandsMock(h.state),
    executeCommand: (command: string, ...args: unknown[]) => {
      if (command === 'setContext' && typeof args[0] === 'string') h.state.contextKeys.set(args[0], args[1]);
      return Promise.resolve();
    },
  },
}));

import type { Instance, InstanceView } from '../../instanceLoader/instance';
import { createDownloadsView } from '../downloadsView';
import { downloadedFileRowFixture } from '../../test/mo2/downloadedFileRowFixture';
import { DownloadedFileNode } from '../DownloadsProvider';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { downloadedFileCommands } from '../../downloadedFileCommands/downloads';

type DownloadsViewDeps = Parameters<typeof createDownloadsView>[0];

const downloadsViewDeps = (instance: InstanceView & Pick<Instance, 'refresh'>): DownloadsViewDeps => ({
  commands: downloadedFileCommands(fakeInstanceAdapter().adapter), queryInfo: () => Promise.resolve({ applied: true, outcome: { landed: [], refused: [] } }), instance, reporter: recordingReporter(),
  ask: () => Promise.resolve(undefined), trash: () => Promise.resolve(),
  log: () => undefined,
  logUnresolved: () => undefined,
});
const command = commandInvoker(h.state);
const treeViews = new FakeTreeViews();
const currentBox = currentBoxOf(h.state);

const instanceOver = (...rows: ReturnType<typeof downloadedFileRowFixture>[]) =>
  new FakeInstance(instanceValueFixture({ downloadedFiles: { kind: 'listed', rows } }));
const viewOver = (instance: FakeInstance) => createDownloadsView(downloadsViewDeps(instance));
const downloadsTree = () => treeViews.view('modbench.downloads');

beforeEach(() => {
  h.state.boxes.length = 0;
  h.state.commands.clear();
  treeViews.clear();
  h.state.contextKeys.clear();
  h.decorationProviders.length = 0;
});

describe('the Downloads view is a flat list whose rows select several at once (common.md, story 6; downloads.md)', () => {
  it('selects several rows and has no Collapse All', () => {
    viewOver(instanceOver(downloadedFileRowFixture('other.7z')));

    const { canSelectMany, showCollapseAll } = downloadsTree().options;
    expect({ canSelectMany, showCollapseAll }).toEqual({ canSelectMany: true, showCollapseAll: undefined });
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const instance = instanceOver(downloadedFileRowFixture('other.7z'));
    const { nameFilter: downloadsFilter } = viewOver(instance);
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await vi.waitFor(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));

    instance.publish(instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('zzznomatch.7z')] } }));
    await vi.waitFor(() => expect(downloadsView.message).toBeUndefined());

    instance.publish(instanceValueFixture());
    await vi.waitFor(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));
  });
});

describe('the Downloads filter follows a toggle with no new instance value', () => {
  it('recomputes the no-match message off Show excluded, in both directions', async () => {
    const { nameFilter: downloadsFilter } = viewOver(instanceOver(downloadedFileRowFixture('zzznomatch.7z', { excluded: true })));
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await vi.waitFor(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));

    await command('modbench.downloadedFile.showExcluded')();
    await vi.waitFor(() => expect(downloadsView.message).toBeUndefined());

    await command('modbench.downloadedFile.hideExcluded')();
    await vi.waitFor(() => expect(downloadsView.message).toBe('No matches for "zzznomatch".'));
  });
});

describe('the Downloads view sets the all-excluded context key', () => {
  const KEY = 'modbench.downloadedFile.allExcluded';
  const contextValue = () => h.state.contextKeys.get(KEY);

  it('is true once the one downloaded file is excluded, and follows Show excluded both ways', async () => {
    viewOver(instanceOver(downloadedFileRowFixture('a.7z', { excluded: true })));

    await vi.waitFor(() => expect(contextValue()).toBe(true));

    await command('modbench.downloadedFile.showExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(false));

    await command('modbench.downloadedFile.hideExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(true));
  });

  it('stays false while at least one downloaded file is not excluded', async () => {
    viewOver(instanceOver(downloadedFileRowFixture('a.7z'), downloadedFileRowFixture('b.7z', { excluded: true })));

    await vi.waitFor(() => expect(contextValue()).toBe(false));
  });
});

describe('the Downloads decoration provider follows a rows change', () => {
  it('fires onDidChangeFileDecorations once the Instance value carries a new downloaded file', async () => {
    const instance = instanceOver();
    viewOver(instance);
    const [provider] = h.decorationProviders;
    const fired = vi.fn();
    present(provider, 'the registered decoration provider').onDidChangeFileDecorations?.(fired);

    instance.publish(instanceValueFixture({ downloadedFiles: { kind: 'listed', rows: [downloadedFileRowFixture('zzznew.7z')] } }));

    await vi.waitFor(() => expect(fired).toHaveBeenCalled());
  });
});

describe('the Downloads view tells its palette entries, which are handed no row, what the selection holds', () => {
  const KEYS = ['singleFile', 'singleFileWithMeta', 'holdsFile', 'holdsIncluded', 'holdsExcluded']
    .map((name) => `modbench.downloadedFile.${name}`);
  const keys = () => Object.fromEntries(KEYS.map((key) => [key, h.state.contextKeys.get(key)]));

  it('sets each key off the selection as it changes', () => {
    viewOver(instanceOver());

    downloadsTree().selectRows([new DownloadedFileNode(downloadedFileRowFixture('a.7z', { hasMeta: true }))]);
    expect(keys()).toEqual({
      'modbench.downloadedFile.singleFile': true, 'modbench.downloadedFile.singleFileWithMeta': true,
      'modbench.downloadedFile.holdsFile': true, 'modbench.downloadedFile.holdsIncluded': true,
      'modbench.downloadedFile.holdsExcluded': false,
    });

    downloadsTree().selectRows([
      new DownloadedFileNode(downloadedFileRowFixture('b.7z', { excluded: true })), new DownloadedFileNode(downloadedFileRowFixture('c.7z', { excluded: true })),
    ]);
    expect(keys()).toEqual({
      'modbench.downloadedFile.singleFile': false, 'modbench.downloadedFile.singleFileWithMeta': false,
      'modbench.downloadedFile.holdsFile': true, 'modbench.downloadedFile.holdsIncluded': false,
      'modbench.downloadedFile.holdsExcluded': true,
    });
  });
});


describe('the Downloads view writes the unresolved folder to the Output', () => {
  it('hands the reason to its log once the Instance value carries it', () => {
    const instance = new FakeInstance(instanceValueFixture());
    const lines: string[] = [];
    createDownloadsView({ ...downloadsViewDeps(instance), logUnresolved: (line) => lines.push(line) });

    instance.publish(instanceValueFixture({ downloadedFiles: { kind: 'unresolved', reason: 'no folder' } }));

    expect(lines).toEqual(['no folder']);
  });
});
