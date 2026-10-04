import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';
import { cloneCorpusFixture, DEFAULT_MODLIST } from './mo2/corpusFixture';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from './vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, currentBoxOf, waitForMessage,
} from '../drivingLib/test/nameFilterViewHarness';
import { fakeView } from '../drivingLib/test/selectableViewDouble';

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
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
  window: {
    ...filterBoxWindowMock(h.state),
    createTreeView: (id: string, options: { treeDataProvider: unknown }) => {
      const view = {
        ...options, description: undefined, message: undefined, selection: [] as readonly unknown[],
        onDidChangeSelection: (listener: (e: { selection: readonly unknown[] }) => void) => {
          h.selectionListeners.push(listener);
          return { dispose: () => undefined };
        },
        get visible() { return h.visible.value; },
        onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => {
          h.visibilityListeners.push(listener);
          return { dispose: () => undefined };
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

import { Instance } from '../instanceLoader/instance';
import { ModListProvider, ModNode, SeparatorNode } from '../mods/ModListProvider';
import {
  createModListView, lastSelectedViewSelection, nexusRowInLastSelectedView,
} from '../treeViews';
import { DownloadNode } from '../downloads/DownloadsProvider';
import { downloadRowFixture } from './mo2/downloadRowFixture';
import { withUnreadCorpusInstance } from './mo2/unreadCorpusInstance';
import { GAME_FOLDER_NOT_FOUND } from './mo2/gameFolderNotFound';
import { adapterOver, STEADY_WINDOW } from './mo2/adapterOver';
import { syncMessageDouble } from './syncMessageDouble';
import { FakeInstance } from './mo2/fakeInstance';
import { instanceValueFixture } from './mo2/instanceValueFixture';

const own = <T extends { dispose: () => void }>(d: T): T => d;

const currentBox = currentBoxOf(h.state);

async function makeSettledInstance(root: string): Promise<Instance> {
  const instance = new Instance({
    window: STEADY_WINDOW,
    adapter: adapterOver(root, { gameFolder: GAME_FOLDER_NOT_FOUND }),
    log: () => undefined,
    logReadFailure: () => undefined,
  });
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
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
    await provider.getChildren();

    const { modListView, modListFilter } = createModListView(own, provider, () => undefined, syncMessageDouble());
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
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
    const { modListView, modListFilter } = createModListView(own, provider, () => undefined, syncMessageDouble());
    expect(modListView.description).toBe('7 / 8');

    modListFilter.open();
    currentBox().type('radfall');
    expect(modListView.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
    const { modListView } = createModListView(own, provider, () => undefined, syncMessageDouble());

    const modlistPath = join(root, DEFAULT_MODLIST);
    await writeFile(modlistPath, `${await readFile(modlistPath, 'utf8')}-Parked Mod\r\n`);
    await instance.refresh();

    expect(modListView.description).toBe('7 / 9');
  });
});

describe('the Mods view tells its keys, which are handed no row, what the selection holds', () => {
  const select = (view: { selection: readonly unknown[] }, rows: readonly unknown[]) => {
    view.selection = rows;
    for (const listener of h.selectionListeners) listener({ selection: rows });
  };

  it('sets the Space direction and the Delete and F2 kind off the selection', async () => {
    const root = cloneCorpusFixture();
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
    const { modListView } = createModListView(own, provider, () => undefined, syncMessageDouble());

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
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
    const { modListView } = createModListView(own, provider, () => undefined, syncMessageDouble());
    select(modListView, [new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false })]);

    const modlistPath = join(root, DEFAULT_MODLIST);
    await writeFile(modlistPath, (await readFile(modlistPath, 'utf8')).replace('-Harder VATS', '+Harder VATS'));
    await instance.refresh();

    expect(h.state.contextKeys.get('modbench.mod.selectionToggle')).toBe('disable');
  });
});

describe('the Mods view expands by reveal a separator a filter shows for its matching mods', () => {
  const mountFiltered = async (term: string, log: (line: string) => void = () => undefined) => {
    const root = cloneCorpusFixture();
    const instance = await makeSettledInstance(root);
    const provider = new ModListProvider({ instance });
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
      const provider = new ModListProvider({ instance });
      const { modListView, modListFilter } = createModListView(own, provider, () => undefined, syncMessageDouble());
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

  it('says mod sync\'s refusal beside it, and drops only that once the sync lands', async () => {
    await withUnreadCorpusInstance(async (instance, root) => {
      await writeFile(join(root, DEFAULT_MODLIST), '# This file was automatically generated by Mod Organizer.\r\n');
      const provider = new ModListProvider({ instance });
      const modSync = syncMessageDouble();
      const { modListView } = createModListView(own, provider, () => undefined, modSync);
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

describe('the Mods view finds a file the filter matches, however deep', () => {
  const file = (relativePath: string) => ({ relativePath, path: `/instance/${relativePath}`, sourcePath: `/instance/${relativePath}`, excluded: false, excludedByName: false });
  const folder = (relativePath: string) => ({ relativePath, path: `/instance/${relativePath}`, excluded: false });
  const revealed = () => h.reveals.map((r) => r.label);
  const open = { select: false, focus: false, expand: true };

  const mountFiltered = (term: string, overwrite = false) => {
    const value = instanceValueFixture({
      mods: [
        { kind: 'mod', name: 'Armour', enabled: true }, { kind: 'separator', name: 'Gear', enabled: false },
        { kind: 'mod', name: 'Boots', enabled: true }, { kind: 'separator', name: 'Other', enabled: false },
      ],
      filesByMod: new Map([['Armour', [file('textures/armour/b.dds')]], ['Boots', [file('gear.esp')]]]),
      foldersByMod: new Map([['Armour', [folder('textures'), folder('textures/armour')]], ['Boots', []]]),
      overwriteFiles: overwrite ? [file('F4SE/a.log')] : [],
      overwriteFolders: overwrite ? [folder('F4SE')] : [],
    });
    const provider = new ModListProvider({ instance: new FakeInstance(value) });
    const { modListView, modListFilter } = createModListView(own, provider, () => undefined, syncMessageDouble());
    modListFilter.open();
    currentBox().type(term);
    return modListView;
  };

  it('reveals, expanded, each row it shows for its matches: the separator, the mod and each folder', async () => {
    mountFiltered('b.dds');
    await vi.waitFor(() => expect(revealed()).toContain('armour'));

    expect(h.reveals).toEqual(['Gear', 'Armour', 'textures', 'armour'].map((label) => ({ label, options: open })));
  });

  it('does not reveal a row shown for its own name, nor the rows under it, while it reveals one shown for a match', async () => {
    const view = mountFiltered('gear');
    await vi.waitFor(() => expect(revealed()).toContain('Boots'));

    expect(view.description).toContain('"gear"');
    expect(revealed()).toEqual(['Other', 'Boots']);
  });

  it('is not told no match by a term that only an Overwrite file matches, and reveals Overwrite open', async () => {
    const view = mountFiltered('a.log', true);
    await vi.waitFor(() => expect(revealed()).toContain('F4SE'));

    expect(view.message).toBeUndefined();
    expect(revealed()).toEqual(['Overwrite', 'F4SE']);
  });

  it('is told no match by a term that only the name Overwrite matches', async () => {
    const view = mountFiltered('overwrite', true);
    await waitForMessage(view, (m) => m === 'No matches for "overwrite".', 'the no-match message');

    expect(revealed()).toEqual([]);
  });
});
