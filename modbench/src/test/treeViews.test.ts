import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  uriFile, DataTransferItem, DataTransfer,
} from './vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, commandInvoker, currentBoxOf, waitForMessage,
} from './nameFilterViewHarness';

// A mod or a download landing on disk is a row change with no keystroke; Show excluded changes
// rows with no new Instance value either. Real Instance and provider over the corpus fixture.

// `../treeViews` reaches `vscode` before this file's own top-level code runs, so the state
// `vi.mock` closes over is built from literals here. `trees` is this file's own tracking of the
// one view `registerDownloadsView` does not return.
const h = vi.hoisted(() => ({
  state: {
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    contextKeys: new Map<string, unknown>(),
    boxes: [],
  },
  trees: new Map<string, { description?: string; message?: string }>(),
  reveals: [] as { label: unknown; options: unknown }[],
  visible: { value: true },
  visibilityListeners: [] as ((e: { visible: boolean }) => void)[],
  selectionListeners: [] as ((e: { selection: readonly unknown[] }) => void)[],
  revealRefusal: { value: undefined as Error | undefined },
  decorationProviders: [] as vscode.FileDecorationProvider[],
}));

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  Uri: { file: uriFile }, DataTransferItem, DataTransfer,
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
      const view = {
        ...options, description: undefined, message: undefined, selection: [] as readonly unknown[],
        onDidChangeSelection: (listener: (e: { selection: readonly unknown[] }) => void) => {
          h.selectionListeners.push(listener);
          return { dispose() { /* no-op */ } };
        },
        get visible() { return h.visible.value; },
        onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => {
          h.visibilityListeners.push(listener);
          return { dispose() { /* no-op */ } };
        },
        reveal: (element: { label: unknown }, revealOptions: unknown) => {
          if (h.revealRefusal.value) return Promise.reject(h.revealRefusal.value);
          h.reveals.push({ label: element.label, options: revealOptions });
          return Promise.resolve();
        },
      };
      h.trees.set(id, view);
      return view;
    },
    registerFileDecorationProvider: (provider: vscode.FileDecorationProvider) => {
      h.decorationProviders.push(provider);
      return { dispose() { /* no-op */ } };
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

import { Instance } from '../instanceLoader/instance';
import { ModListProvider, ModNode, SeparatorNode } from '../mods/ModListProvider';
import {
  createFocusedView, createModListView, lastSelectedViewSelection, nexusRowInLastSelectedView, registerDownloadsView, type DownloadsViewDeps,
} from '../treeViews';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { downloadRowFixture } from './mo2/downloadRowFixture';
import { present } from '../ports/present';
import { recordingReporter } from './surfacingDoubles';
import { withUnreadCorpusInstance } from './mo2/unreadCorpusInstance';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import { accessTo, adapterOver, STEADY_WINDOW } from './mo2/adapterOver';
import { syncMessageDouble } from './syncMessageDouble';

const own = <T extends { dispose: () => void }>(d: T): T => d;

const downloadsViewDeps = (instanceRoot: string, instance: Instance): DownloadsViewDeps => ({
  own, access: accessTo(instanceRoot), instance, reporter: recordingReporter(),
  ask: () => Promise.resolve(undefined), trash: () => Promise.resolve(),
  install: { nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ } },
});
const command = commandInvoker(h.state);
const currentBox = currentBoxOf(h.state);

async function makeInstance(root: string): Promise<Instance> {
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: GAME_FOLDER_NOT_FOUND }),
    log: () => { /* no-op */ },
    logReadFailure: () => { /* no-op */ },
  });
  // The first read binds the downloads watcher and schedules one more read; a refresh runs that
  // read now, so no value lands later to re-render a test's rows behind its back.
  await instance.refresh();
  await instance.refresh();
  return instance;
}

beforeEach(() => {
  h.state.boxes.length = 0;
  h.state.commands.clear();
  h.reveals.length = 0;
  h.visible.value = true;
  h.visibilityListeners.length = 0;
  h.selectionListeners.length = 0;
  h.state.contextKeys.clear();
  h.revealRefusal.value = undefined;
  h.decorationProviders.length = 0;
});

describe('the Mods filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    await provider.getChildren();

    const { modListView, modListFilter } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());
    modListFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(modListView.message).toBe('No matches for "zzznomatch".');

    const modlistPath = join(root, DEFAULT_MODLIST);
    const original = await readFile(modlistPath, 'utf8');
    await writeFile(modlistPath, `${original}+zzznomatchMod\r\n`);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === undefined, 'the message clearing once a matching mod lands');
    expect(modListView.message).toBeUndefined();

    await writeFile(modlistPath, original);
    await instance.refresh();
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the mod is gone');
    expect(modListView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Mods view\'s description counts the mods', () => {
  it('reads the enabled mods over the listed mods, then the term, counting the whole list', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    const { modListView, modListFilter } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());
    expect(modListView.description).toBe('7 / 8');

    modListFilter.open();
    currentBox().type('radfall');
    expect(modListView.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());

    const modlistPath = join(root, DEFAULT_MODLIST);
    await writeFile(modlistPath, `${await readFile(modlistPath, 'utf8')}-Parked Mod\r\n`);
    await instance.refresh();

    expect(modListView.description).toBe('7 / 9');
  });
});

// mods.md, Menus and keys: a key is handed no row, so its `when` clause reads the selection.
describe('the Mods view tells its keys what the selection holds', () => {
  const select = (view: { selection: readonly unknown[] }, rows: readonly unknown[]) => {
    view.selection = rows;
    for (const listener of h.selectionListeners) listener({ selection: rows });
  };

  it('sets the Space direction and the Delete and F2 kind off the selection', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());

    const SELECTION_KEYS = ['selectionToggle', 'selectionKind', 'singleRow', 'holdsEnabledMod', 'holdsDisabledMod']
      .map((name) => `modbench.mod.${name}`);
    const keys = () => Object.fromEntries(SELECTION_KEYS.map((key) => [key, h.state.contextKeys.get(key)]));
    const harderVats = new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false });
    const separator = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

    select(modListView, [harderVats]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': 'enable', 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': true,
    });

    select(modListView, [separator('Radfall - All-In-One Survival Overhaul'), separator('Unassigned (Modlist Development)')]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': undefined, 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': false,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': false,
    });
  });

  it('follows a mod enabled on disk while the selection still holds the row built before', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());
    select(modListView, [new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false })]);

    const modlistPath = join(root, DEFAULT_MODLIST);
    await writeFile(modlistPath, (await readFile(modlistPath, 'utf8')).replace('-Harder VATS', '+Harder VATS'));
    await instance.refresh();

    expect(h.state.contextKeys.get('modbench.mod.selectionToggle')).toBe('disable');
  });
});

// VS Code keeps the expansion it remembers for a known row identity over the provider's
// collapsible state, so the filter's expansion is a reveal.
describe('the Mods view expands a separator a filter shows for its matching mods', () => {
  const mountFiltered = async (term: string, log: (line: string) => void = () => { /* no-op */ }) => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
    createModListView(own, provider, log, syncMessageDouble()).modListFilter.open();
    currentBox().type(term);
    await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it('reveals it expanded, neither selecting nor focusing it', async () => {
    await mountFiltered('tracked');

    expect(h.reveals).toEqual([
      { label: 'Unassigned (Modlist Development)', options: { select: false, focus: false, expand: true } },
    ]);
  });

  it('leaves a separator shown for its own name as the user left it', async () => {
    await mountFiltered('radfall - all');

    expect(h.reveals).toEqual([]);
  });

  it('writes a reveal VS Code refuses to the Output, naming the separator and why', async () => {
    h.revealRefusal.value = new Error('Cannot resolve tree item');
    const lines: string[] = [];
    await mountFiltered('tracked', (line) => lines.push(line));

    expect(lines).toEqual([
      'Could not expand "Unassigned (Modlist Development)" for the filter: Cannot resolve tree item',
    ]);
  });

  // A reveal opens a hidden view.
  it('reveals nothing while the view is hidden, and reveals it once the view is shown', async () => {
    h.visible.value = false;
    await mountFiltered('tracked');
    expect(h.reveals).toEqual([]);

    h.visible.value = true;
    for (const listener of h.visibilityListeners) listener({ visible: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.reveals.map((r) => r.label)).toEqual(['Unassigned (Modlist Development)']);
  });
});

describe('the Mods view says when the list is empty', () => {
  const NO_MODS = 'No mods or separators. Install Mod… or Create Empty Mod…, in the title bar\'s overflow menu, adds one.';

  it('says nothing before the first read, says so once an empty list lands, and gives way to the no-match message', async () => {
    await withUnreadCorpusInstance(async (instance, root) => {
      await writeFile(join(root, DEFAULT_MODLIST), '# This file was automatically generated by Mod Organizer.\r\n');
      const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
      const { modListView, modListFilter } = createModListView(own, provider, () => { /* no-op */ }, syncMessageDouble());
      expect(modListView.message).toBeUndefined();
      expect(modListView.description).toBeUndefined();

      await instance.refresh();
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

      modListFilter.open();
      currentBox().type('zzz');
      await waitForMessage(modListView, (m) => m === 'No matches for "zzz".', 'the no-match message');

      currentBox().type('');
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message back');
      provider.dispose();
    });
  });

  // Rival: mod sync's refusal replacing the empty-list message, or never reaching the line.
  it('says mod sync\'s refusal beside it, and drops only that once the sync lands', async () => {
    await withUnreadCorpusInstance(async (instance, root) => {
      await writeFile(join(root, DEFAULT_MODLIST), '# This file was automatically generated by Mod Organizer.\r\n');
      const provider = new ModListProvider({ instance, access: accessTo(root), log: () => undefined });
      const modSync = syncMessageDouble();
      const { modListView } = createModListView(own, provider, () => { /* no-op */ }, modSync);
      // The first read binds the downloads watcher and schedules one more read; a refresh runs
      // that read now, so no later value can re-render the line behind the test's back.
      await instance.refresh();
      await instance.refresh();
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

      const syncRefused = 'modlist.txt is not synced: /instance/mods does not exist.';
      modSync.say(syncRefused);
      await waitForMessage(modListView, (m) => m === `${NO_MODS} ${syncRefused}`, 'both messages');

      modSync.say(undefined);
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message alone');
      provider.dispose();
    });
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);

    const { downloadsFilter } = registerDownloadsView(downloadsViewDeps(root, instance));
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    downloadsFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once a matching download lands');
    expect(downloadsView.message).toBeUndefined();

    await rm(archivePath);
    await instance.refresh();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the download is gone');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Downloads filter follows a toggle with no new instance value', () => {
  it('recomputes the no-match message off Show excluded, in both directions', async () => {
    const root = cloneCorpusFixture();
    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await writeFile(`${archivePath}.meta`, '[General]\r\nremoved=true\r\n');
    const instance = await makeInstance(root);

    const { downloadsFilter } = registerDownloadsView(downloadsViewDeps(root, instance));
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

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

// downloads.md, States, story 2: distinct from "no downloads yet" — package.json's viewsWelcome
// gates on this key.
describe('the Downloads view sets the all-excluded context key', () => {
  const KEY = 'modbench.downloadedFile.allExcluded';
  const contextValue = () => h.state.contextKeys.get(KEY);

  it('is true once the corpus\'s one download is excluded, and follows Show excluded both ways', async () => {
    const root = cloneCorpusFixture();
    const metaPath = join(root, 'downloads', 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z.meta');
    await writeFile(metaPath, '[General]\r\ngameName=Fallout4\r\nmodID=4598\r\ninstalled=true\r\nremoved=true\r\n');
    const instance = await makeInstance(root);

    registerDownloadsView(downloadsViewDeps(root, instance));

    await vi.waitFor(() => expect(contextValue()).toBe(true));

    await command('modbench.downloadedFile.showExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(false));

    await command('modbench.downloadedFile.hideExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(true));
  });

  it('stays false while at least one download is not excluded', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(downloadsViewDeps(root, instance));

    await vi.waitFor(() => expect(h.trees.get('modbench.downloads')).toBeDefined());
    expect(contextValue()).not.toBe(true);
  });
});

// downloads.md, A row, "Excluded": the dim follows exclude and include at once — VS Code never
// re-queries a FileDecorationProvider on its own.
describe('the Downloads decoration provider follows a rows change', () => {
  it('fires onDidChangeFileDecorations once the Instance value carries a new download', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(downloadsViewDeps(root, instance));
    const [provider] = h.decorationProviders;
    const fired = vi.fn();
    present(provider, 'the registered decoration provider').onDidChangeFileDecorations?.(fired);

    await writeFile(join(root, 'downloads', 'zzznew.7z'), '');
    await instance.refresh();

    await vi.waitFor(() => expect(fired).toHaveBeenCalled());
  });
});

// commands.md, view on Nexus: the palette hands the command no row, so the Downloads view says
// whether its selection is one the gesture takes.
describe('the Downloads view tells its palette entries what the selection holds', () => {
  const KEYS = ['singleFile', 'singleFileWithMeta', 'holdsFile', 'holdsIncluded', 'holdsExcluded']
    .map((name) => `modbench.downloadedFile.${name}`);
  const keys = () => Object.fromEntries(KEYS.map((key) => [key, h.state.contextKeys.get(key)]));
  const select = (view: { selection: readonly unknown[] }, rows: readonly unknown[]) => {
    view.selection = rows;
    for (const listener of h.selectionListeners) listener({ selection: rows });
  };

  it('sets each key off the selection as it changes', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeInstance(root);
    const { downloadsView } = registerDownloadsView(downloadsViewDeps(root, instance));

    select(downloadsView, [new DownloadNode(downloadRowFixture('a.7z', { hasMeta: true }))]);
    expect(keys()).toEqual({
      'modbench.downloadedFile.singleFile': true, 'modbench.downloadedFile.singleFileWithMeta': true,
      'modbench.downloadedFile.holdsFile': true, 'modbench.downloadedFile.holdsIncluded': true,
      'modbench.downloadedFile.holdsExcluded': false,
    });

    select(downloadsView, [
      new DownloadNode(downloadRowFixture('b.7z', { excluded: true })), new DownloadNode(downloadRowFixture('c.7z', { excluded: true })),
    ]);
    expect(keys()).toEqual({
      'modbench.downloadedFile.singleFile': false, 'modbench.downloadedFile.singleFileWithMeta': false,
      'modbench.downloadedFile.holdsFile': true, 'modbench.downloadedFile.holdsIncluded': false,
      'modbench.downloadedFile.holdsExcluded': true,
    });
  });
});

type SelectionChange = vscode.TreeViewSelectionChangeEvent<unknown>;
function fakeView(): { selection: readonly unknown[]; select(rows: readonly unknown[]): void; onDidChangeSelection: vscode.Event<SelectionChange> } {
  const listeners: ((e: SelectionChange) => void)[] = [];
  const view = {
    selection: [] as readonly unknown[],
    select(rows: readonly unknown[]) {
      view.selection = rows;
      for (const listener of listeners) listener({ selection: rows });
    },
    onDidChangeSelection: (listener: (e: SelectionChange) => void) => {
      listeners.push(listener);
      return { dispose() { /* no-op */ } };
    },
  };
  return view;
}

// commands.md, No dead entries: a gesture is absent, not refused, where its condition is false, so
// the palette offers view on Nexus exactly on the view whose row it opens.
describe('view on Nexus from the palette: the row it opens and the view the palette offers it on', () => {
  const KEY = 'modbench.mod.nexusRowIn';

  it('offers it on the view whose one selected row it opens, and nowhere while that row has no Nexus id', () => {
    const mods = fakeView();
    const downloads = fakeView();
    const nexusRow = nexusRowInLastSelectedView(own, [
      { id: 'modbench.modList', view: mods }, { id: 'modbench.downloads', view: downloads },
    ]);
    const nexusMod = new ModNode({ kind: 'mod', name: 'On Nexus', enabled: true, nexusId: '42' });
    const nexusFile = new DownloadNode(downloadRowFixture('a.7z', { modID: '7' }));

    expect([h.state.contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    mods.select([nexusMod]);
    expect([h.state.contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.modList', nexusMod]);
    downloads.select([new DownloadNode(downloadRowFixture('b.7z'))]);
    expect([h.state.contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
    downloads.select([nexusFile]);
    expect([h.state.contextKeys.get(KEY), nexusRow()]).toEqual(['modbench.downloads', nexusFile]);
    mods.select([nexusMod, new ModNode({ kind: 'mod', name: 'Also', enabled: true, nexusId: '43' })]);
    expect([h.state.contextKeys.get(KEY), nexusRow()]).toEqual([undefined, undefined]);
  });
});

// commands.md, Principles: a palette entry takes the focused view's selection. No stable API names
// the focused view, so the entry is offered only on the view last selected in, which the key names.
describe('a palette gesture two views offer: the selection of the view last selected in', () => {
  const KEY = 'modbench.mod.trackRowsIn';

  it('takes the selection of the view last selected in, and names that view in its key', () => {
    const mods = fakeView();
    const plugins = fakeView();
    const selection = lastSelectedViewSelection(own, [
      { id: 'modbench.modList', view: mods }, { id: 'modbench.pluginListTree', view: plugins },
    ], KEY);

    expect([h.state.contextKeys.get(KEY), selection()]).toEqual([undefined, []]);
    mods.select(['ModA', 'ModB']);
    expect([h.state.contextKeys.get(KEY), selection()]).toEqual(['modbench.modList', ['ModA', 'ModB']]);
    plugins.select(['First.esp']);
    expect([h.state.contextKeys.get(KEY), selection()]).toEqual(['modbench.pluginListTree', ['First.esp']]);
  });
});

// commands.md, Every view: copy value and filter act on the focused view. No stable API names it,
// so it is the view last selected in, or the one a surface outside the trees says it entered.
describe('the focused view', () => {
  it('is none until a view is selected in or entered', () => {
    expect(createFocusedView().id()).toBeUndefined();
  });

  it('is the followed view last selected in', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    const plugins = fakeView();
    focused.follow('modbench.modList', mods);
    focused.follow('modbench.pluginListTree', plugins);
    mods.select(['ModA']);
    expect(focused.id()).toBe('modbench.modList');
    plugins.select(['First.esp']);
    expect(focused.id()).toBe('modbench.pluginListTree');
  });

  it('is a surface outside the trees from the moment it is entered, until a tree is selected in again', () => {
    const focused = createFocusedView();
    const mods = fakeView();
    focused.follow('modbench.modList', mods);
    mods.select(['ModA']);
    focused.enter('modbench.recordGrid');
    expect(focused.id()).toBe('modbench.recordGrid');
    mods.select(['ModB']);
    expect(focused.id()).toBe('modbench.modList');
  });
});
