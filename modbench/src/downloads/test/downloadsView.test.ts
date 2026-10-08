import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString, uriFile, uriFrom,
} from '../../test/vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, commandInvoker, currentBoxOf, waitForMessage,
} from '../../drivingLib/test/nameFilterViewHarness';

const h = vi.hoisted(() => ({
  state: {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, unknown>(),
    boxes: [],
  },
  trees: new Map<string, { description?: string; message?: string }>(),
  selectionListeners: [] as ((e: { selection: readonly unknown[] }) => void)[],
  decorationProviders: [] as vscode.FileDecorationProvider[],
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile, from: uriFrom },
  Disposable: { from: (...all: { dispose(): unknown }[]) => ({ dispose: () => { for (const d of all) d.dispose(); } }) },
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
      const view = {
        ...options, description: undefined, message: undefined, selection: [] as readonly unknown[],
        onDidChangeSelection: (listener: (e: { selection: readonly unknown[] }) => void) => {
          h.selectionListeners.push(listener);
          return { dispose: () => undefined };
        },
        dispose: () => undefined,
      };
      h.trees.set(id, view);
      return view;
    },
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
import { downloadNodeFixture } from '../../test/mo2/downloadNodeFixture';
import { downloadRowFixture } from '../../test/mo2/downloadRowFixture';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { recordingReporter } from '../../test/surfacingDoubles';
import { accessTo } from '../../test/mo2/adapterOver';

type DownloadsViewDeps = Parameters<typeof createDownloadsView>[0];

const downloadsViewDeps = (instanceRoot: string, instance: InstanceView & Pick<Instance, 'refresh'>): DownloadsViewDeps => ({
  access: accessTo(instanceRoot), instance, reporter: recordingReporter(),
  ask: () => Promise.resolve(undefined), trash: () => Promise.resolve(),
  log: () => undefined,
  logUnresolved: () => undefined,
});
const command = commandInvoker(h.state);
const currentBox = currentBoxOf(h.state);

const INSTANCE_ROOT = '/instance';
const instanceOver = (...rows: ReturnType<typeof downloadRowFixture>[]) =>
  new FakeInstance(instanceValueFixture({ downloads: { kind: 'listed', rows } }));
const viewOver = (instance: FakeInstance) => createDownloadsView(downloadsViewDeps(INSTANCE_ROOT, instance));
const downloadsTree = () => present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

beforeEach(() => {
  h.state.boxes.length = 0;
  h.state.commands.clear();
  h.selectionListeners.length = 0;
  h.state.contextKeys.clear();
  h.decorationProviders.length = 0;
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const instance = instanceOver(downloadRowFixture('other.7z'));
    const { nameFilter: downloadsFilter } = viewOver(instance);
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    instance.publish(instanceValueFixture({ downloads: { kind: 'listed', rows: [downloadRowFixture('zzznomatch.7z')] } }));
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once a matching download lands');
    expect(downloadsView.message).toBeUndefined();

    instance.publish(instanceValueFixture());
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the download is gone');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Downloads filter follows a toggle with no new instance value', () => {
  it('recomputes the no-match message off Show excluded, in both directions', async () => {
    const { nameFilter: downloadsFilter } = viewOver(instanceOver(downloadRowFixture('zzznomatch.7z', { excluded: true })));
    const downloadsView = downloadsTree();

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message with the excluded download left out');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    await command('modbench.downloadedFile.showExcluded')();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once the excluded download counts');
    expect(downloadsView.message).toBeUndefined();

    await command('modbench.downloadedFile.hideExcluded')();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once excluded rows are left out again');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Downloads view sets the all-excluded context key', () => {
  const KEY = 'modbench.downloadedFile.allExcluded';
  const contextValue = () => h.state.contextKeys.get(KEY);

  it('is true once the one download is excluded, and follows Show excluded both ways', async () => {
    viewOver(instanceOver(downloadRowFixture('a.7z', { excluded: true })));

    await vi.waitFor(() => expect(contextValue()).toBe(true));

    await command('modbench.downloadedFile.showExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(false));

    await command('modbench.downloadedFile.hideExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(true));
  });

  it('stays false while at least one download is not excluded', async () => {
    viewOver(instanceOver(downloadRowFixture('a.7z'), downloadRowFixture('b.7z', { excluded: true })));

    await vi.waitFor(() => expect(contextValue()).toBe(false));
  });
});

describe('the Downloads decoration provider follows a rows change', () => {
  it('fires onDidChangeFileDecorations once the Instance value carries a new download', async () => {
    const instance = instanceOver();
    viewOver(instance);
    const [provider] = h.decorationProviders;
    const fired = vi.fn();
    present(provider, 'the registered decoration provider').onDidChangeFileDecorations?.(fired);

    instance.publish(instanceValueFixture({ downloads: { kind: 'listed', rows: [downloadRowFixture('zzznew.7z')] } }));

    await vi.waitFor(() => expect(fired).toHaveBeenCalled());
  });
});

describe('the Downloads view tells its palette entries, which are handed no row, what the selection holds', () => {
  const KEYS = ['singleFile', 'singleFileWithMeta', 'holdsFile', 'holdsIncluded', 'holdsExcluded']
    .map((name) => `modbench.downloadedFile.${name}`);
  const keys = () => Object.fromEntries(KEYS.map((key) => [key, h.state.contextKeys.get(key)]));
  const select = (view: { selection: readonly unknown[] }, rows: readonly unknown[]) => {
    view.selection = rows;
    for (const listener of h.selectionListeners) listener({ selection: rows });
  };

  it('sets each key off the selection as it changes', () => {
    const { view: downloadsView } = viewOver(instanceOver());

    select(downloadsView, [downloadNodeFixture(downloadRowFixture('a.7z', { hasMeta: true }))]);
    expect(keys()).toEqual({
      'modbench.downloadedFile.singleFile': true, 'modbench.downloadedFile.singleFileWithMeta': true,
      'modbench.downloadedFile.holdsFile': true, 'modbench.downloadedFile.holdsIncluded': true,
      'modbench.downloadedFile.holdsExcluded': false,
    });

    select(downloadsView, [
      downloadNodeFixture(downloadRowFixture('b.7z', { excluded: true })), downloadNodeFixture(downloadRowFixture('c.7z', { excluded: true })),
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
    createDownloadsView({ ...downloadsViewDeps(INSTANCE_ROOT, instance), logUnresolved: (line) => lines.push(line) });

    instance.publish(instanceValueFixture({ downloads: { kind: 'unresolved', reason: 'no folder' } }));

    expect(lines).toEqual(['no folder']);
  });
});
