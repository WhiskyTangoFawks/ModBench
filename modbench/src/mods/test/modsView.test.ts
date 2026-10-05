import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor, MarkdownString,
  uriFile, uriFrom, DataTransferItem, DataTransfer,
} from '../../test/vscodeMock';
import {
  filterBoxWindowMock, filterBoxCommandsMock, currentBoxOf, waitForMessage,
} from '../../drivingLib/test/nameFilterViewHarness';

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
        get visible() { return h.visible.value; },
        onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => {
          h.visibilityListeners.push(listener);
          return { dispose: () => undefined };
        },
        onDidChangeCheckboxState: () => ({ dispose: () => undefined }),
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

import type { ModlistEntry } from '../../instanceLoader/instance';
import { ModNode, SeparatorNode } from '../ModListProvider';
import { createModsView } from '../modsView';
import { present } from '../../ports/present';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const currentBox = currentBoxOf(h.state);

const NO_SYNC = {
  syncMods: () => Promise.resolve({ applied: true as const, added: [], dropped: [] }),
  channel: { error: () => undefined, info: () => undefined },
};

const mod = (name: string, enabled = true): ModlistEntry => ({ kind: 'mod', name, enabled });
const separator = (name: string): ModlistEntry => ({ kind: 'separator', name, enabled: true });

const LISTED_MODS: ModlistEntry[] = [
  mod('Ñoño\'s Retexture'), mod('Tracked Patch Mod'), mod('SKK Fast Start new game (Fallout 4)'),
  separator('Unassigned (Modlist Development)'),
  mod('[NODELETE] Radfall'), mod('Unofficial Fallout 4 Patch'),
  separator('Radfall - All-In-One Survival Overhaul'),
  mod('ENBoost - 12k'), mod('Harder VATS', false), mod('Cracked and Smudged Pip-Boy Screen'),
];

const instanceListing = (mods: ModlistEntry[]) => new FakeInstance(instanceValueFixture({ mods }));
const listing = (mods: ModlistEntry[]) => instanceValueFixture({ mods });

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
    const instance = instanceListing(LISTED_MODS);
    const { provider, view: modListView, nameFilter: modListFilter } =
      createModsView({ instance, log: () => undefined, ...NO_SYNC });
    await provider.getChildren();

    modListFilter.open();
    currentBox().type('zzznomatch');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message after the keystroke');
    expect(modListView.message).toBe('No matches for "zzznomatch".');

    instance.publish(listing([...LISTED_MODS, mod('zzznomatchMod')]));
    await waitForMessage(modListView, (m) => m === undefined, 'the message clearing once a matching mod lands');
    expect(modListView.message).toBeUndefined();

    instance.publish(listing(LISTED_MODS));
    await waitForMessage(modListView, (m) => m === 'No matches for "zzznomatch".', 'the message returning once the mod is gone');
    expect(modListView.message).toBe('No matches for "zzznomatch".');
  });
});

describe('the Mods view\'s description counts the mods', () => {
  it('reads the enabled mods over the listed mods, then the term, counting the whole list', () => {
    const instance = instanceListing(LISTED_MODS);
    const { view: modListView, nameFilter: modListFilter } = createModsView({ instance, log: () => undefined, ...NO_SYNC });
    expect(modListView.description).toBe('7 / 8');

    modListFilter.open();
    currentBox().type('radfall');
    expect(modListView.description).toBe('7 / 8 · "radfall"');
  });

  it('follows a new instance value, with nothing pushed', () => {
    const instance = instanceListing(LISTED_MODS);
    const { view: modListView } = createModsView({ instance, log: () => undefined, ...NO_SYNC });

    instance.publish(listing([...LISTED_MODS, mod('Parked Mod', false)]));

    expect(modListView.description).toBe('7 / 9');
  });
});

describe('the Mods title-bar sort icons', () => {
  it('set the tree\'s own direction, and the key the icon reads', async () => {
    const instance = instanceListing(LISTED_MODS);
    const { provider } = createModsView({ instance, log: () => undefined, ...NO_SYNC });

    expect(h.state.contextKeys.get('modbench.mod.winningAtTop')).toBe(false);
    await h.state.commands.get('modbench.mod.sortWinningAtTop')?.();
    expect([provider.viewDirection(), h.state.contextKeys.get('modbench.mod.winningAtTop')]).toEqual(['winningAtTop', true]);
    await h.state.commands.get('modbench.mod.sortLosingAtTop')?.();
    expect([provider.viewDirection(), h.state.contextKeys.get('modbench.mod.winningAtTop')]).toEqual(['losingAtTop', false]);
  });
});

describe('the Mods view tells its keys, which are handed no row, what the selection holds', () => {
  const select = (view: { selection: readonly unknown[] }, rows: readonly unknown[]) => {
    view.selection = rows;
    for (const listener of h.selectionListeners) listener({ selection: rows });
  };

  it('sets the Space direction and the Delete and F2 kind off the selection', () => {
    const instance = instanceListing(LISTED_MODS);
    const { view: modListView } = createModsView({ instance, log: () => undefined, ...NO_SYNC });

    const SELECTION_KEYS = ['selectionToggle', 'selectionKind', 'singleRow', 'holdsEnabledMod', 'holdsDisabledMod']
      .map((name) => `modbench.mod.${name}`);
    const keys = () => Object.fromEntries(SELECTION_KEYS.map((key) => [key, h.state.contextKeys.get(key)]));
    const harderVats = new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false });
    const separatorRow = (name: string) => new SeparatorNode({ kind: 'separator', name, enabled: true }, []);

    select(modListView, [harderVats]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': 'enable', 'modbench.mod.selectionKind': 'mod', 'modbench.mod.singleRow': true,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': true,
    });

    select(modListView, [separatorRow('Radfall - All-In-One Survival Overhaul'), separatorRow('Unassigned (Modlist Development)')]);
    expect(keys()).toEqual({
      'modbench.mod.selectionToggle': undefined, 'modbench.mod.selectionKind': 'separator', 'modbench.mod.singleRow': false,
      'modbench.mod.holdsEnabledMod': false, 'modbench.mod.holdsDisabledMod': false,
    });
  });

  it('follows a mod enabled on disk while the selection still holds the row built before', () => {
    const instance = instanceListing(LISTED_MODS);
    const { view: modListView } = createModsView({ instance, log: () => undefined, ...NO_SYNC });
    select(modListView, [new ModNode({ kind: 'mod', name: 'Harder VATS', enabled: false })]);

    instance.publish(listing(LISTED_MODS.map((m) => (m.name === 'Harder VATS' ? mod('Harder VATS') : m))));

    expect(h.state.contextKeys.get('modbench.mod.selectionToggle')).toBe('disable');
  });
});

describe('the Mods view expands by reveal a separator a filter shows for its matching mods', () => {
  const mountFiltered = async (term: string, log: (line: string) => void = () => undefined) => {
    createModsView({ instance: instanceListing(LISTED_MODS), log, ...NO_SYNC }).nameFilter.open();
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
    const instance = new FakeInstance(listing([]), 0);
    const { view: modListView, nameFilter: modListFilter } = createModsView({ instance, log: () => undefined, ...NO_SYNC });
    expect(modListView.message).toBeUndefined();
    expect(modListView.description).toBeUndefined();

    instance.publish(listing([]));
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

    modListFilter.open();
    currentBox().type('zzz');
    await waitForMessage(modListView, (m) => m === 'No matches for "zzz".', 'the no-match message');

    currentBox().type('');
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message back');
  });

  it('says mod sync\'s refusal beside it, and drops only that once the sync lands', async () => {
    const instance = new FakeInstance(listing([]), 0);
    const outcomes = [
      { applied: false as const, refusal: '/instance/mods does not exist' },
      { applied: true as const, added: [], dropped: [] },
    ];
    let run = 0;
    const { view: modListView, modSync } = createModsView({
      instance, log: () => undefined, channel: NO_SYNC.channel, syncMods: () => Promise.resolve(present(outcomes[run++], 'an outcome for this run')),
    });
    instance.publish(listing([]));
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message');

    await modSync.run(instance.value.modSyncArguments);
    await waitForMessage(modListView, (m) => m === `${NO_MODS} modlist.txt is not synced: /instance/mods does not exist.`, 'both messages');

    await modSync.run(instance.value.modSyncArguments);
    await waitForMessage(modListView, (m) => m === NO_MODS, 'the empty-list message alone');
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
    const { view: modListView, nameFilter: modListFilter } =
      createModsView({ instance: new FakeInstance(value), log: () => undefined, ...NO_SYNC });
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
