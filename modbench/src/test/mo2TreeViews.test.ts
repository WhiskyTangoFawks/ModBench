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

// A mod or a download landing on disk is a row change with no keystroke; Show hidden changes
// rows with no new Instance value either. Real Instance and provider over the corpus fixture.

// `../mo2TreeViews` reaches `vscode` before this file's own top-level code runs, so the state
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
import { createModListView, registerDownloadsView } from '../mo2TreeViews';
import { present } from '../ports/present';
import { recordingReporter } from './surfacingDoubles';
import { withUnreadCorpusInstance } from './mo2/unreadCorpusInstance';
import { resolvesNotFound } from './mo2/gameFolderNotFound';

const own = <T extends { dispose: () => void }>(d: T): T => d;
const command = commandInvoker(h.state);
const currentBox = currentBoxOf(h.state);

async function makeInstance(root: string): Promise<Instance> {
  const instance = new Instance({
    instanceRoot: root,
    resolveGameDirectory: resolvesNotFound,
    log: () => { /* no-op */ },
    logReadFailure: () => { /* no-op */ },
  });
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
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    await provider.getChildren();

    const { modListView } = createModListView(own, provider, () => { /* no-op */ });
    await command('modbench.mod.filter')();
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
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ });
    expect(modListView.description).toBe('7 / 8');

    await command('modbench.mod.filter')();
    currentBox().type('radfall');
    expect(modListView.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ });

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
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ });

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
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    const { modListView } = createModListView(own, provider, () => { /* no-op */ });
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
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);
    const provider = new ModListProvider({ instance, instanceRoot: root });
    createModListView(own, provider, log);
    await command('modbench.mod.filter')();
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
      const provider = new ModListProvider({ instance, instanceRoot: root });
      const { modListView } = createModListView(own, provider, () => { /* no-op */ });
      expect(modListView.message).toBeUndefined();
      expect(modListView.description).toBeUndefined();

      await instance.refresh();
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

      await command('modbench.mod.filter')();
      currentBox().type('zzz');
      await waitForMessage(modListView, (m) => m === 'No matches for "zzz".', 'the no-match message');

      currentBox().type('');
      await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message back');
      provider.dispose();
    });
  });
});

describe('the Downloads filter follows a row change with no keystroke', () => {
  it('recomputes the no-match message off a new instance value, in both directions', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), () => Promise.resolve(), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ },
    });
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    await command('modbench.downloadedFile.filter')();
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
  it('recomputes the no-match message off Show hidden, in both directions', async () => {
    const root = await cloneCorpusFixture();
    const archivePath = join(root, 'downloads', 'zzznomatch.7z');
    await writeFile(archivePath, '');
    await writeFile(`${archivePath}.meta`, '[General]\r\nremoved=true\r\n');
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), () => Promise.resolve(), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ },
    });
    const downloadsView = present(h.trees.get('modbench.downloads'), 'the registered Downloads TreeView');

    await command('modbench.downloadedFile.filter')();
    currentBox().type('zzznomatch');
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message with the hidden download excluded');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');

    await command('modbench.downloadedFile.showExcluded')();
    await waitForMessage(downloadsView, (m) => m === undefined, 'the message clearing once the hidden download counts');
    expect(downloadsView.message).toBeUndefined();

    await command('modbench.downloadedFile.hideExcluded')();
    await waitForMessage(downloadsView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once hidden rows are excluded again');
    expect(downloadsView.message).toBe('No matches for "zzznomatch".');
  });
});

// downloads.md, States, story 2: distinct from "no downloads yet" — package.json's viewsWelcome
// gates on this key.
describe('the Downloads view sets the all-excluded context key', () => {
  const KEY = 'modbench.downloadedFile.allExcluded';
  const contextValue = () => h.state.contextKeys.get(KEY);

  it('is true once the corpus\'s one download is excluded, and follows Show excluded both ways', async () => {
    const root = await cloneCorpusFixture();
    const metaPath = join(root, 'downloads', 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z.meta');
    await writeFile(metaPath, '[General]\r\ngameName=Fallout4\r\nmodID=4598\r\ninstalled=true\r\nremoved=true\r\n');
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), () => Promise.resolve(), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ },
    });

    await vi.waitFor(() => expect(contextValue()).toBe(true));

    await command('modbench.downloadedFile.showExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(false));

    await command('modbench.downloadedFile.hideExcluded')();
    await vi.waitFor(() => expect(contextValue()).toBe(true));
  });

  it('stays false while at least one download is not excluded', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), () => Promise.resolve(), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ },
    });

    await vi.waitFor(() => expect(h.trees.get('modbench.downloads')).toBeDefined());
    expect(contextValue()).not.toBe(true);
  });
});

// downloads.md, A row, "Excluded": the dim follows exclude and include at once — VS Code never
// re-queries a FileDecorationProvider on its own.
describe('the Downloads decoration provider follows a rows change', () => {
  it('fires onDidChangeFileDecorations once the Instance value carries a new download', async () => {
    const root = await cloneCorpusFixture();
    const instance = await makeInstance(root);

    registerDownloadsView(own, root, instance, recordingReporter(), () => Promise.resolve(undefined), () => Promise.resolve(), {
      nameNewMod: () => Promise.resolve(undefined), warnIfFomod: () => { /* no-op */ }, log: () => { /* no-op */ },
    });
    const [provider] = h.decorationProviders;
    const fired = vi.fn();
    present(provider, 'the registered decoration provider').onDidChangeFileDecorations?.(fired);

    await writeFile(join(root, 'downloads', 'zzznew.7z'), '');
    await instance.refresh();

    await vi.waitFor(() => expect(fired).toHaveBeenCalled());
  });
});
