import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginsDrop } from '../../pluginCommands/plugins';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import type { PluginAddress } from '../../wire/pluginAddress';
import type { InstanceValue } from '../../instanceLoader/instance';
import {
  type PluginDiagnosisReport, type PluginLoadFailure, type PluginMetadata, type RecordPage,
  type WorldspaceSummary, type InteriorCellBlock, type RecordSummary, type CellChildRecords,
  type ContainerChildSummary, type CellSummary, type ChildRecordSummary, type MEditClient, type ModStatus,
} from '../../client';
import type { ReadFailed } from '../../wire/readFailed';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

const moveCommands = vi.hoisted(() => [] as { plugins: PluginAddress[]; drop: PluginsDrop }[]);

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    ...fakeVscodeModule(),
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
    Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
    window: { withProgress: recordedWithProgress },
    commands: {
      executeCommand: (id: string, _clicked: unknown, rows: { plugin: { name: string }; origin: string }[], drop: PluginsDrop) => {
        if (id === 'modbench.plugin.move') moveCommands.push({ plugins: rows.map(({ plugin, origin }) => ({ name: plugin.name, origin })), drop });
        return Promise.resolve();
      },
    },
  };
});

import * as vscode from 'vscode';
import { PluginsTreeProvider, NO_PLUGINS_MESSAGE } from '../PluginsTreeProvider';
import { PluginNode, ImplicitMasterNode, type PluginsTreeNode } from '../pluginRows';
import { RecordBrowser } from '../RecordBrowser';
import { pluginsTreeOver } from './pluginsTreeOver';
import { status } from '../../test/modStatusFixture';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { present } from '../../ports/present';
import { parseRowResourceUri } from '../recordResourceUri';
import { GAME_FOLDER_NOT_FOUND } from '../../test/mo2/gameFolderNotFound';
import { CONTAINER_TYPES, listsForThePluginAsked } from '../../client/test/fixtures';

function plugin(
  overrides: Partial<Omit<LoadOrderPlugin, 'path'>> & { name: string; path?: string },
): LoadOrderPlugin | LoadOrderPluginLine {
  return {
    path: `/fixture/${overrides.name}`,
    origin: 'SomeMod',
    line: 0,
    enabled: true,
    winning: true,
    ...overrides,
  };
}

function valueOf(
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[], pluginsLoadedWithNoLine?: readonly (string | PluginAddress)[],
): InstanceValue {
  const mods = [...new Set(plugins.map((p) => p.origin))].filter((origin) => origin !== 'Data/' && origin !== 'overwrite/');
  return instanceValueFixture({
    mods: mods.map((name) => ({ kind: 'mod' as const, name, enabled: true })),
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    pluginsLoadedWithNoLine: pluginsLoadedWithNoLine?.map((p) => {
      const address = typeof p === 'string' ? { name: p, origin: 'Data/' } : p;
      return { ...address, path: address.origin === 'Data/' ? `/game/Data/${address.name}` : `/instance/mods/${address.origin}/${address.name}` };
    }),
    plugins, paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map(mods.map((m) => [m, `/instance/mods/${m}`])), sourceDirs: new Map() },
  });
}

const failIfNotSettledWithin = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

beforeEach(() => { moveCommands.length = 0; });

const moves = () => moveCommands.map(({ plugins, drop }) => ({ names: plugins.map((p) => p.name), drop }));

function held(name: string, overrides: Partial<PluginMetadata> = {}): PluginMetadata {
  return {
    name,
    path: `/data/${name}`,
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    isBlueprint: false,
    masters: [],
    isImmutable: false,
    origin: 'SomeMod',
    missingMasters: [],
    inLoadOrder: true,
    hasMatchingRecords: true,
    isCompiledPlugin: false,
    hasParseFailure: false,
    pluginSourceUnreadable: null,
    ...overrides,
  };
}

function recordSummary(overrides: Partial<RecordSummary> = {}): RecordSummary {
  return {
    formKey: '000001:A.esp', plugin: 'A.esp', loadOrderIndex: 0, isWinner: true,
    editorId: 'TheWeapon', origin: 'SomeMod', workingTreeState: 'None',
    hasContainerChildren: false, hasParseFailure: false,
    ...overrides,
  };
}

type WorldspaceBlocks = Exclude<Awaited<ReturnType<MEditClient['getWorldspaceBlocks']>>, ReadFailed>;

function makeClient(overrides: Partial<{
  plugins: PluginMetadata[];
  diagnoses: PluginDiagnosisReport[];
  recordTypes: { type: string; count: number; displayName?: string; hasParseFailure?: boolean; isCreatable?: boolean }[];
  records: RecordPage;
  worldspaces: WorldspaceSummary[];
  worldspaceBlocks: WorldspaceBlocks;
  interiorCells: InteriorCellBlock[];
  cellChildRecords: CellChildRecords;
  containerChildren: ContainerChildSummary[];
}> = {}): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', overrides.plugins ?? []);
  client.setQueryAnswer('getDiagnoses', overrides.diagnoses ?? []);
  client.setQueryAnswer('getRecordTypes', (overrides.recordTypes ?? []).map((rt) => ({
    type: rt.type, count: rt.count, displayName: rt.displayName ?? rt.type, hasParseFailure: rt.hasParseFailure ?? false,
    isCreatable: rt.isCreatable ?? true, isContainer: CONTAINER_TYPES.has(rt.type),
  })));
  client.setQueryAnswer('getRecords', overrides.records ?? { items: [], total: 0 });
  client.setQueryAnswer('getWorldspaces', overrides.worldspaces ?? []);
  client.setQueryAnswer('getWorldspaceBlocks', overrides.worldspaceBlocks ?? { blocks: [], topCells: [] });
  client.setQueryAnswer('getCellChildRecords', overrides.cellChildRecords ?? { persistent: [], temporary: [] });
  client.setQueryAnswer('getContainerChildren', overrides.containerChildren ?? []);
  client.setQueryAnswer('getInteriorCells', overrides.interiorCells ?? []);
  return client;
}

interface Harness {
  tree: PluginsTreeProvider;
  client: InMemoryMEditClient;
  records: RecordBrowser;
  instance: FakeInstance;
}

function makeTree(
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
  extra: Partial<{
    instance: FakeInstance;
    client: InMemoryMEditClient;
    publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
    publishChangedOutside: ConstructorParameters<typeof PluginsTreeProvider>[0]['publishChangedOutside'];
    loadedWithNoLine: readonly (string | PluginAddress)[];
  }> = {},
): Harness {
  const instance = extra.instance ?? new FakeInstance(valueOf(plugins, extra.loadedWithNoLine));
  const client = extra.client ?? makeClient();
  const records = new RecordBrowser(client);
  const tree = pluginsTreeOver(instance, {
    client, records,
    ...(extra.publishDiagnoses && { publishDiagnoses: extra.publishDiagnoses }),
    ...(extra.publishChangedOutside && { publishChangedOutside: extra.publishChangedOutside }),
  });
  return { tree, client, records, instance };
}

async function reconcile(
  h: Harness, plugins: PluginMetadata[], failures: PluginLoadFailure[] = [],
): Promise<void> {
  h.client.setQueryAnswer('getPlugins', plugins);
  await h.tree.facts.reconciled(failures);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const STILL_INDEXING = [['indexing', 'Still indexing…']];

function rendered(rows: readonly { contextValue?: string; label?: unknown }[]): unknown[] {
  return rows.map((row) => [row.contextValue, row.label]);
}

function callCount(client: InMemoryMEditClient, method: string): number {
  return client.calls.filter((c) => c.method === method).length;
}

describe('ImplicitMasterNode — leading line', () => {
  it('renders a lock icon, not a checkbox, as VS Code has no non-interactive checkbox variant', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data/');
    expect(node.iconPath).toEqual({ id: 'lock' });
    expect(node.checkboxState).toBeUndefined();
  });

  it('tooltip is MO2\'s one sentence alone, with no file name', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data/');
    expect(node.tooltip).toBe("This plugin can't be disabled or moved (enforced by the game).");
  });

  it('keys resourceUri on the plugin\'s address, for the label-graying decoration provider', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data/');
    expect(parseRowResourceUri(node.resourceUri)).toEqual({ plugin: { name: 'Fallout4.esm', origin: 'Data/' }, path: [] });
  });

  it('keys a plugin row on the same address, so the states beneath it can be asked', () => {
    const node = new PluginNode({ name: 'Mod.esp', enabled: true }, 'ModA');
    expect(parseRowResourceUri(present(node.resourceUri, 'the plugin row\'s URI'))).toEqual({ plugin: { name: 'Mod.esp', origin: 'ModA' }, path: [] });
  });

});

describe('PluginNode / ImplicitMasterNode — row click opens the plugin header', () => {
  it('PluginNode opens the header at the plugin and origin its row stands for', () => {
    const node = new PluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod');
    expect(node.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey: '000000:TestMod.esp', plugin: { name: 'TestMod.esp', origin: 'SomeMod' } } }],
    });
  });

  it('ImplicitMasterNode opens the header at the plugin and origin its row stands for', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data/');
    expect(node.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record', arguments: [{ argument: { kind: 'record', formKey: '000000:Fallout4.esm', plugin: { name: 'Fallout4.esm', origin: 'Data/' } } }],
    });
  });

  it('two plugins of one file name from different origins open at different addresses', () => {
    const a = new PluginNode({ name: 'Same.esp', enabled: true }, 'ModA');
    const b = new PluginNode({ name: 'Same.esp', enabled: true }, 'ModB');
    expect(a.command?.arguments).not.toEqual(b.command?.arguments);
  });
});

describe('a plugin row carries its plugin as its Argument', () => {
  it.each([
    ['a plugin line', new PluginNode({ name: 'A.esp', enabled: true }, 'ModA')],
    ['a plugin the game loads with none', new ImplicitMasterNode('A.esp', 'ModA')],
  ])('%s', (_what, node) => {
    expect(node.argument).toEqual({ kind: 'plugin', plugin: { name: 'A.esp', origin: 'ModA' } });
  });
});

describe('PluginNode', () => {
  it('renders a plain row — no icon, no description', () => {
    const node = new PluginNode({ name: 'A.esp', enabled: true }, 'SomeMod');
    expect(node.iconPath).toEqual(new ThemeIcon('blank'));
    expect(node.description).toBeUndefined();
  });

});

describe('PluginsTreeProvider — rows come from the Instance value', () => {
  it('builds one row per plugins.txt line, in Plugin load order, with the enabled checkbox', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', line: 0, enabled: false }),
      plugin({ name: 'B.esp', line: 1, enabled: true }),
    ]);
    const rows = await tree.getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeInstanceOf(PluginNode);
    expect(expectInstanceOf(rows[0], PluginNode).label).toBe('A.esp');
    expect(expectInstanceOf(rows[0], PluginNode).checkboxState).toBe(TreeItemCheckboxState.Unchecked);
    expect(expectInstanceOf(rows[1], PluginNode).label).toBe('B.esp');
    expect(expectInstanceOf(rows[1], PluginNode).checkboxState).toBe(TreeItemCheckboxState.Checked);
  });

  it('renders no row, and says so in the message line, with no lines and no locked plugins', async () => {
    const { tree } = makeTree([]);

    expect(await tree.getChildren()).toEqual([]);
    expect(tree.viewMessage()).toBe(NO_PLUGINS_MESSAGE);
  });

  it('says nothing about an empty list while the game loads a plugin on its own', async () => {
    const { tree } = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] });

    expect(await tree.getChildren()).toHaveLength(1);
    expect(tree.viewMessage()).toBeUndefined();
  });

  it('takes the message back once a line lands', async () => {
    const instance = new FakeInstance(valueOf([]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();

    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0 })]));
    await tree.getChildren();

    expect(tree.viewMessage()).toBeUndefined();
  });

  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', line: 0 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES plugins.txt');

    expect(tree.viewMessage()).toBe('Showing the last good read: EACCES plugins.txt');
    expect(fired).toHaveLength(1);
    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0 })]));
    expect(tree.viewMessage()).toBeUndefined();
  });

  it('says the later read that failed on the message line, and not once the next read answers', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0 })]);
    await h.tree.getChildren();
    const failing = held('A.esp', { laterReadFailure: [{ sourceRelativePath: 'A.esp/Npc.json', message: 'bad' }] });

    await reconcile(h, [failing]);
    expect(h.tree.viewMessage()).toContain('Showing the last good read: "A.esp"');
    expect(h.tree.standingMessage()).toContain('A.esp/Npc.json: bad');

    await reconcile(h, [held('A.esp')]);
    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('carries each row\'s own origin from the Instance value', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', line: 0, origin: 'ModA' }),
      plugin({ name: 'B.esp', line: 1, origin: 'overwrite/' }),
    ]);
    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);
    expect(rows.map((r) => r.origin)).toEqual(['ModA', 'overwrite/']);
  });

  it('resolvePluginPath returns undefined for a LoadOrderPluginLine, never "undefined" as text', async () => {
    const { tree } = makeTree([plugin({ name: 'Fallout4.esm', line: 0, path: undefined })]);
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'Fallout4.esm', enabled: true }, 'SomeMod'))).toBeUndefined();
  });

  it('re-renders on a new value published after construction', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', line: 0 })]));
    const { tree } = makeTree([], { instance });
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);

    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'B.esp', line: 1 })]));

    expect(fired).toBe(true);
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const { tree } = makeTree([], { instance });

    const pending = tree.getChildren();
    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'B.esp', line: 1 })]));
    const rendered = await pending;

    expect(rendered.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
    expect((await tree.getChildren()).map((r) => r.label)).toEqual(['A.esp', 'B.esp']);
  });

  it('settles a failed first read on the one error row naming the reason, raises nothing, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const { tree } = makeTree([], { instance });

    const pending = tree.getChildren();
    instance.fail('EISDIR: illegal operation on a directory, read plugins.txt');
    const rows = await failIfNotSettledWithin(pending, 500);

    expect(rows).toHaveLength(1);
    const error = present(rows[0], 'the error row');
    expect(error.label).toBe('Failed to load: EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.tooltip).toBe('EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));

    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0 })]));
    const after = await failIfNotSettledWithin(tree.getChildren(), 500);

    expect(after.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);
  });

  it('says nothing about an empty list before the first read lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const { tree } = makeTree([], { instance });

    const pending = tree.getChildren();
    expect(tree.viewMessage()).toBeUndefined();
    instance.publish(valueOf([]));
    await failIfNotSettledWithin(pending, 500);

    expect(tree.viewMessage()).toBe(NO_PLUGINS_MESSAGE);
  });
});

describe('PluginsTreeProvider — a plugin row is identified by its kind and (origin, filename)', () => {
  const idsOf = async (tree: PluginsTreeProvider): Promise<(string | undefined)[]> =>
    (await tree.getChildren()).map((row) => row.id);

  it('keeps each row\'s identity across a rebuild that moves it', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'B.esp', line: 1 })]));
    const { tree } = makeTree([], { instance });
    const [a, b] = await idsOf(tree);

    instance.publish(valueOf([plugin({ name: 'B.esp', line: 0 }), plugin({ name: 'A.esp', line: 1 })]));

    expect(await idsOf(tree)).toEqual([b, a]);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('gives the plugin of the same name from another origin another identity', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', line: 0, origin: 'ModA' })]));
    const { tree } = makeTree([], { instance });
    const [fromModA] = await idsOf(tree);

    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0, origin: 'ModB' })]));

    const [fromModB] = await idsOf(tree);
    expect(fromModB).toBeDefined();
    expect(fromModB).not.toBe(fromModA);
  });

  it('gives a locked row an identity of its own kind, never a plugin row\'s', async () => {
    const withLine = makeTree([plugin({ name: 'Fallout4.esm', line: 0, origin: 'Data/' })]).tree;
    const locked = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] }).tree;

    const [lineId] = await idsOf(withLine);
    const [lockedId] = await idsOf(locked);

    expect(lockedId).toBeDefined();
    expect(lockedId).not.toBe(lineId);
  });

});

describe('PluginsTreeProvider — name filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Alpha.esp', line: 0 }),
      plugin({ name: 'Beta.esp', line: 1 }),
      plugin({ name: 'AlphaExtra.esp', line: 2 }),
    ]);
    tree.setFilter('ALPHA');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('finds the row it shows under the id of a row VS Code holds from before a rebuild', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]));
    const { tree } = makeTree([], { instance });
    const [held] = expectInstancesOf(await tree.getChildren(), PluginNode);
    await instance.refresh();

    const shown = tree.shownRow(expectInstanceOf(held, PluginNode));

    expect(shown?.id).toBe(held?.id);
    expect(shown).not.toBe(held);
  });

  it('finds no row for a plugin the instance does not hold now', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]));
    const { tree } = makeTree([], { instance });
    const [alpha] = expectInstancesOf(await tree.getChildren(), PluginNode);
    instance.publish(valueOf([plugin({ name: 'Beta.esp', line: 0 })]));

    expect(tree.shownRow(expectInstanceOf(alpha, PluginNode))).toBeUndefined();
  });

  it('finds no row for a plugin the name filter hides', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]);
    const [alpha] = expectInstancesOf(await tree.getChildren(), PluginNode);
    tree.setFilter('beta');

    expect(tree.shownRow(expectInstanceOf(alpha, PluginNode))).toBeUndefined();
  });

  it('restores the full list when the filter is cleared', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]);
    tree.setFilter('alpha');
    expect(await tree.getChildren()).toHaveLength(1);

    tree.setFilter('');
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('returns an empty list, and no empty-list message, when the filter matches nothing', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]);
    tree.setFilter('nomatch');
    const rows = await tree.getChildren();

    expect(rows).toEqual([]);
    expect(tree.viewMessage()).toBeUndefined();
  });

  it('survives an instance value change, narrowing whatever it turns up', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]));
    const { tree } = makeTree([], { instance });
    tree.setFilter('alpha');
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp']);

    instance.publish(valueOf([
      plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 }), plugin({ name: 'AlphaTwo.esp', line: 2 }),
    ]));

    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'AlphaTwo.esp']);
  });

  it('narrowing a rendered tree asks it to render again, and its rows come back narrowed', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', line: 0 }), plugin({ name: 'Beta.esp', line: 1 })]);
    await tree.getChildren();
    let askedToRerender = false;
    tree.onDidChangeTreeData(() => { askedToRerender = true; });

    tree.setFilter('alpha');

    expect(askedToRerender).toBe(true);
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp']);
  });
});

const IGNORED_TOKEN = new FakeCancellationToken();

function payloadOf(item: unknown): unknown {
  return expectInstanceOf(item, DataTransferItem).value;
}

describe('PluginsTreeProvider — drag-and-drop reorder', () => {
  const ORDER = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const fixturePlugins = (names: string[] = ORDER) => names.map((name, line) => plugin({ name, line }));
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');

  async function drag(moved: string[], target: string | undefined, names: string[] = ORDER) {
    const instance = Object.assign(new FakeInstance(valueOf(fixturePlugins(names))), { refresh: () => Promise.resolve() });
    const tree = pluginsTreeOver(instance);
    await tree.getChildren();
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });

    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, IGNORED_TOKEN);
    return { fired };
  }

  it('carries the origin of each dragged row, so two plugins of one filename stay apart', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();

    tree.handleDrag([
      new PluginNode({ name: 'Same.esp', enabled: true }, 'ModOne'),
      new PluginNode({ name: 'Same.esp', enabled: true }, 'ModTwo'),
    ], dt, IGNORED_TOKEN);

    expect(payloadOf(dt.get('application/vnd.medit.pluginlist-node')))
      .toEqual({ plugins: [{ name: 'Same.esp', origin: 'ModOne' }, { name: 'Same.esp', origin: 'ModTwo' }] });
  });

  it('handleDrag serialises the whole selection, not just the grabbed row', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp'), node('C.esp')], dt, IGNORED_TOKEN);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(payloadOf(item)).toEqual({ plugins: [{ name: 'A.esp', origin: 'SomeMod' }, { name: 'C.esp', origin: 'SomeMod' }] });
  });

  it('a drop of rows the view does not hold moves nothing, and does not fall back to the selection', async () => {
    await drag(['Gone.esp'], 'D.esp');
    expect(moveCommands).toEqual([]);
  });

  it('a drop fires nothing before the read lands', async () => {
    const { fired } = await drag(['A.esp'], 'D.esp');
    expect(fired).toBe(false);
  });

  it.each([['a record row', 1], ['a record-type group row', 0]])('drop onto %s of this tree is refused, not treated as the end of the list', async (_name, depth) => {
    const plugins = fixturePlugins();
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }], records: { items: [recordSummary()], total: 1 } });
    const h = makeTree(plugins, { client });
    await reconcile(h, plugins.map((p) => held(p.name, { origin: p.origin })));
    const [pluginRow] = await h.tree.getChildren();
    const [group] = await h.tree.getChildren(present(pluginRow, 'the first plugin row'));
    const target = depth === 0 ? group : (await h.tree.getChildren(present(group, 'the Weapon group')))[0];
    const dt = new DataTransfer();
    h.tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);

    await h.tree.handleDrop(present(target, 'the browser row'), dt, IGNORED_TOKEN);

    expect(moves()).toEqual([]);
  });

  it.each(['C.esp', 'c.ESP'])('a drop on a row being dragged asks for nothing, the dragged name being %s', async (dragged) => {
    await drag(['A.esp', dragged], 'C.esp');
    expect(moves()).toEqual([]);
  });

  it('an empty drag payload is a no-op (no write)', async () => {
    const { tree } = makeTree(fixturePlugins());
    await tree.getChildren();
    await tree.handleDrop(node('A.esp'), new DataTransfer(), IGNORED_TOKEN);
    expect(moves()).toEqual([]);
  });

  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const NAMES = ['M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'];

    await drag(['M1.esp'], 'M3.esp', NAMES);
    const baseline = moves();
    moveCommands.length = 0;

    const tree = pluginsTreeOver(new FakeInstance(valueOf(fixturePlugins(NAMES))));
    await tree.getChildren();
    tree.setFilter('m');
    const visible = await tree.getChildren();
    expect(visible.map((n) => expectInstanceOf(n, PluginNode).plugin.name)).toEqual(['M1.esp', 'M2.esp', 'M3.esp']);

    const dt = new DataTransfer();
    tree.handleDrag([node('M1.esp')], dt, IGNORED_TOKEN);
    await tree.handleDrop(node('M3.esp'), dt, IGNORED_TOKEN);

    expect(moves()).toEqual(baseline);
  });

});

describe('PluginsTreeProvider — isEnabled', () => {
  it('answers from the Instance value, matching the row\'s file name and origin without case', () => {
    const { tree } = makeTree([
      plugin({ name: 'Mod.esp', line: 0, origin: 'ModA', enabled: true }),
      plugin({ name: 'Off.esp', line: 1, origin: 'ModA', enabled: false }),
    ]);

    expect(tree.isEnabled(new PluginNode({ name: 'mod.ESP', enabled: false }, 'moda'))).toBe(true);
    expect(tree.isEnabled(new PluginNode({ name: 'Off.esp', enabled: true }, 'ModA'))).toBe(false);
  });

  it('answers false for a row of the same file name at another origin', () => {
    const { tree } = makeTree([plugin({ name: 'Mod.esp', line: 0, origin: 'ModA', enabled: true })]);

    expect(tree.isEnabled(new PluginNode({ name: 'Mod.esp', enabled: true }, 'ModB'))).toBe(false);
  });
});

describe('PluginsTreeProvider — resolvePluginPath (Reveal in Explorer)', () => {
  const lockedRowOf = async (tree: PluginsTreeProvider) =>
    present((await tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');

  it('resolves a plugin row to its own plugin\'s file, by origin and file name', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', line: 0, origin: 'Winner', path: '/data/mods/Winner/Base.esp', winning: true }),
      plugin({ name: 'Base.esp', line: 0, origin: 'Loser', path: '/data/mods/Loser/Base.esp', winning: false }),
    ]);
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'base.esp', enabled: true }, 'Loser'))).toBe('/data/mods/Loser/Base.esp');
  });

  it('returns undefined when no plugin has the row\'s origin and file name', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Base.esp', line: 0, origin: 'OtherMod' })]);
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'Base.esp', enabled: true }, 'SomeMod'))).toBeUndefined();
  });

  it('resolves a locked row the game loads from a mod to that mod\'s copy, not the game folder\'s', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Fallout4.esm', line: 0, origin: 'SomeMod', path: '/instance/mods/SomeMod/Fallout4.esm' })],
      { loadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'SomeMod' }] });
    const locked = await lockedRowOf(tree);

    expect(locked.origin).toBe('SomeMod');
    expect(await tree.resolvePluginPath(locked)).toBe('/instance/mods/SomeMod/Fallout4.esm');
  });

  it('resolves a locked row no mod provides to the game folder\'s copy', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Mod.esp', line: 0 })],
      { loadedWithNoLine: ['Fallout4.esm'] });

    expect(await tree.resolvePluginPath(await lockedRowOf(tree))).toBe('/game/Data/Fallout4.esm');
  });

  it('resolves a locked row the value does not list to nothing', async () => {
    const { tree } = makeTree([]);
    expect(await tree.resolvePluginPath(new ImplicitMasterNode('Fallout4.esm', 'Data/'))).toBeUndefined();
  });
});

describe('PluginsTreeProvider — implicit master rows', () => {
  const ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT = null;
  const treeFor = (
    plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
    implicit: readonly string[] | typeof ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT = [],
  ) => makeTree(plugins, {
    ...(implicit === ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT ? {} : { loadedWithNoLine: implicit }),
  }).tree;

  it('renders the backend names as ImplicitMasterNode rows preceding plugins.txt rows, in the order given, not sorted (DLCCoast.esm would sort ahead of Fallout4.esm), with no checkbox and contextValue pluginImplicit', async () => {
    const rows = await treeFor(
      [plugin({ name: 'Mod.esp', line: 0 })], ['Fallout4.esm', 'DLCCoast.esm'],
    ).getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm', 'DLCCoast.esm', 'Mod.esp']);
    expect(rows[0]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[1]).toBeInstanceOf(ImplicitMasterNode);
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).contextValue).toBe('pluginImplicit');
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).checkboxState).toBeUndefined();
    expect(rows[2]).toBeInstanceOf(PluginNode);
  });

  it('renders a plugins.txt line of the same filename from another origin as its own row (ADR-0012)', async () => {
    const rows = await treeFor([plugin({ name: 'Fallout4.esm', line: 0, origin: 'SomeMod' })], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.kind)).toEqual(['implicitMaster', 'plugin']);
  });

  it('gives two game folder files that differ only in case a row each, each with an id of its own', async () => {
    const rows = await treeFor([], ['Master.esm', 'master.esm']).getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Master.esm', 'master.esm']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('publishes each locked row\'s URI, for the graying decoration provider', async () => {
    const tree = treeFor([plugin({ name: 'Mod.esp', line: 0 })], ['Fallout4.esm']);
    const [locked] = await tree.getChildren();
    const rowUri = present(expectInstanceOf(locked, ImplicitMasterNode).resourceUri, 'the locked row\'s URI');
    expect([...tree.lockedRowUris()]).toEqual([rowUri.toString()]);
  });

  it('renders no implicit row, and every plugins.txt line, when the value cannot say', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', line: 0 })], ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT).getChildren();

    expect(rows.some((r) => r instanceof ImplicitMasterNode)).toBe(false);
    expect(rows.map((r) => r.label)).toEqual(['Mod.esp']);
    expect([...treeFor([], ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT).lockedRowUris()]).toEqual([]);
  });

  it('renders only implicit rows when plugins.txt is empty, rather than the empty state', async () => {
    const rows = await treeFor([], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('handleDrag still filters to only PluginNode rows, excluding implicit rows for free', async () => {
    const tree = treeFor([plugin({ name: 'Mod.esp', line: 0 })], ['Fallout4.esm']);
    const rows = await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(rows, dt, IGNORED_TOKEN);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(payloadOf(item)).toMatchObject({ plugins: [{ name: 'Mod.esp' }] });
  });
});

describe('PluginsTreeProvider — the sort direction', () => {
  const LOCKED = ['Fallout4.esm', 'DLCRobot.esm'];
  const LINES = () => [plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'B.esp', line: 1 }), plugin({ name: 'C.esp', line: 2 })];
  const labelsOf = async (tree: PluginsTreeProvider) => (await tree.getChildren()).map((row) => row.label);

  it('lists losing at the top until told otherwise', async () => {
    const { tree } = makeTree(LINES(), { loadedWithNoLine: LOCKED });

    expect(await labelsOf(tree)).toEqual(['Fallout4.esm', 'DLCRobot.esm', 'A.esp', 'B.esp', 'C.esp']);
  });

  it('lists winning at the top with the locked plugins at the bottom, and back again', async () => {
    const { tree } = makeTree(LINES(), { loadedWithNoLine: LOCKED });

    tree.setViewDirection('winningAtTop');
    expect(await labelsOf(tree)).toEqual(['C.esp', 'B.esp', 'A.esp', 'DLCRobot.esm', 'Fallout4.esm']);

    tree.setViewDirection('losingAtTop');
    expect(await labelsOf(tree)).toEqual(['Fallout4.esm', 'DLCRobot.esm', 'A.esp', 'B.esp', 'C.esp']);
  });

  it('flips the very rows it had, rebuilding none', async () => {
    const { tree } = makeTree(LINES(), { loadedWithNoLine: LOCKED });
    const before = await tree.getChildren();
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });

    tree.setViewDirection('winningAtTop');

    expect(fired).toBe(true);
    const after = [...(await tree.getChildren())].reverse();
    expect(after).toEqual(before);
    expect(new Set([...before, ...after]).size).toBe(before.length);
  });

  it('keeps the order of the groups and records beneath a plugin', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'acti', count: 2, displayName: 'Activator' }, { type: 'weap', count: 1, displayName: 'Weapon' }],
      records: {
        items: [recordSummary({ formKey: '000001:A.esp', editorId: 'First' }), recordSummary({ formKey: '000002:A.esp', editorId: 'Second' })],
        total: 2,
      },
    });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const beneath = async () => {
      const [row] = await h.tree.getChildren();
      const groups = await h.tree.getChildren(present(row, 'the A.esp row'));
      const records = await h.tree.getChildren(present(groups[0], 'the Activator group'));
      return [...groups, ...records].map((node) => node.label);
    };
    const losingAtTop = await beneath();

    h.tree.setViewDirection('winningAtTop');

    expect(await beneath()).toEqual(losingAtTop);
    expect(losingAtTop).toEqual(['Activator', 'Weapon', 'First', 'Second']);
  });

  it('narrows the flipped rows by the name filter', async () => {
    const { tree } = makeTree([...LINES(), plugin({ name: 'AB.esp', line: 3 })]);

    tree.setViewDirection('winningAtTop');
    tree.setFilter('a');

    expect(await labelsOf(tree)).toEqual(['AB.esp', 'A.esp']);
  });
});

describe('PluginsTreeProvider — a drop asks for the place it is shown, in either sort direction', () => {
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');
  const LINES = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const LOCKED_ROW = new ImplicitMasterNode('Fallout4.esm', 'Data/');

  it.each([
    { direction: 'losingAtTop', moved: ['E.esp'], where: 'B.esp', target: node('B.esp'), drop: { kind: 'before', name: 'B.esp' } },
    { direction: 'losingAtTop', moved: ['B.esp', 'C.esp', 'D.esp'], where: 'A.esp', target: node('A.esp'), drop: { kind: 'before', name: 'A.esp' } },
    { direction: 'losingAtTop', moved: ['A.esp', 'C.esp', 'E.esp'], where: 'D.esp', target: node('D.esp'), drop: { kind: 'before', name: 'D.esp' } },
    { direction: 'losingAtTop', moved: ['A.esp'], where: 'below the last row', target: undefined, drop: { kind: 'winningEnd' } },
    { direction: 'losingAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED_ROW, drop: { kind: 'losingEnd' } },
    { direction: 'winningAtTop', moved: ['A.esp'], where: 'D.esp', target: node('D.esp'), drop: { kind: 'after', name: 'D.esp' } },
    { direction: 'winningAtTop', moved: ['A.esp', 'B.esp'], where: 'D.esp', target: node('D.esp'), drop: { kind: 'after', name: 'D.esp' } },
    { direction: 'winningAtTop', moved: ['E.esp'], where: 'below the last row', target: undefined, drop: { kind: 'losingEnd' } },
    { direction: 'winningAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED_ROW, drop: { kind: 'losingEnd' } },
  ] as const)('$direction: $moved dropped on $where asks for $drop', async ({ direction, moved, target, drop }) => {
    const tree = pluginsTreeOver(new FakeInstance(valueOf(LINES.map((name, line) => plugin({ name, line })), ['Fallout4.esm'])));
    tree.setViewDirection(direction);
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);

    await tree.handleDrop(target, dt, IGNORED_TOKEN);

    expect(moves()).toEqual([{ names: moved, drop }]);
    expect(moveCommands.flatMap(({ plugins }) => plugins)).toEqual(moved.map((name) => ({ name, origin: 'SomeMod' })));
  });

  it('moves the dragged plugin alone when another origin holds a plugin of its file name', async () => {
    const lines = [plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'Same.esp', line: 1, origin: 'ModA' }), plugin({ name: 'Same.esp', line: 2, origin: 'ModB' })];
    const tree = pluginsTreeOver(new FakeInstance(valueOf(lines)));
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([new PluginNode({ name: 'Same.esp', enabled: true }, 'ModB')], dt, IGNORED_TOKEN);

    await tree.handleDrop(node('A.esp'), dt, IGNORED_TOKEN);

    expect(moveCommands.flatMap(({ plugins }) => plugins)).toEqual([{ name: 'Same.esp', origin: 'ModB' }]);
  });
});

describe('PluginsTreeProvider — the places a move offers are the drops on its rows', () => {
  const LINES = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const treeOfLines = () => pluginsTreeOver(new FakeInstance(valueOf(LINES.map((name, line) => plugin({ name, line })), ['Fallout4.esm'])));

  it('losing at the top: above each row outside the selection, as shown, then the bottom of the view at the winning end', () => {
    const tree = treeOfLines();

    expect(tree.movePlaces(['B.esp', 'D.esp'])).toEqual([
      { label: 'A.esp', drop: { kind: 'before', name: 'A.esp' } },
      { label: 'C.esp', drop: { kind: 'before', name: 'C.esp' } },
      { label: 'E.esp', drop: { kind: 'before', name: 'E.esp' } },
      { label: 'Bottom of the view', drop: { kind: 'winningEnd' } },
    ]);
  });

  it('winning at the top: above each row outside the selection, as shown, then the bottom of the view at the losing end', () => {
    const tree = treeOfLines();
    tree.setViewDirection('winningAtTop');

    expect(tree.movePlaces(['B.esp', 'D.esp'])).toEqual([
      { label: 'E.esp', drop: { kind: 'after', name: 'E.esp' } },
      { label: 'C.esp', drop: { kind: 'after', name: 'C.esp' } },
      { label: 'A.esp', drop: { kind: 'after', name: 'A.esp' } },
      { label: 'Bottom of the view', drop: { kind: 'losingEnd' } },
    ]);
  });

  it('offers a row the name filter hides', () => {
    const tree = treeOfLines();
    tree.setFilter('b');

    expect(tree.movePlaces(['B.esp']).map(({ label }) => label)).toEqual(['A.esp', 'C.esp', 'D.esp', 'E.esp', 'Bottom of the view']);
  });
});

describe('PluginsTreeProvider — the locked plugins follow the instance value', () => {
  const LINES = () => [plugin({ name: 'Fallout4.esm', line: 0, origin: 'Data/' }), plugin({ name: 'Mod.esp', line: 1 })];
  const shapeOf = async (tree: PluginsTreeProvider) => (await tree.getChildren())
    .map((row) => (row instanceof PluginNode || row instanceof ImplicitMasterNode ? `${row.kind} ${row.kind === 'plugin' ? row.plugin.name : row.name}` : row.kind));

  it('shows a line naming a locked plugin as an ordinary row while the value cannot say, then locks it at the losing end', async () => {
    const instance = new FakeInstance(valueOf(LINES()));
    const h = makeTree([], { instance });
    expect(await shapeOf(h.tree)).toEqual(['plugin Fallout4.esm', 'plugin Mod.esp']);

    instance.publish(valueOf(LINES(), ['Fallout4.esm', 'DLCRobot.esm']));

    expect(await shapeOf(h.tree)).toEqual(['implicitMaster Fallout4.esm', 'implicitMaster DLCRobot.esm', 'plugin Mod.esp']);
  });
});

const A_ROW = () => plugin({ name: 'A.esp', line: 0, origin: 'SomeMod' });
const B_ROW = () => plugin({ name: 'B.esp', line: 1, origin: 'SomeMod' });

function makeDisconnectedClient(): InMemoryMEditClient {
  return disconnect(makeClient());
}

function disconnect(client: InMemoryMEditClient): InMemoryMEditClient {
  client.disconnected();
  return client;
}

describe('PluginsTreeProvider — a plugin row\'s expander follows its line, not what mEdit holds', () => {
  it('gives an enabled row a chevron whether or not mEdit holds its plugin, and a disabled row none', async () => {
    const h = makeTree([A_ROW(), B_ROW(), plugin({ name: 'Off.esp', line: 2, enabled: false })]);
    await reconcile(h, [held('A.esp'), held('Off.esp')]);
    const rows = await h.tree.getChildren();
    const chevrons = () => rows.map((row) => h.tree.getTreeItem(row).collapsibleState);
    const { Collapsed, None } = vscode.TreeItemCollapsibleState;

    expect(chevrons()).toEqual([Collapsed, Collapsed, None]);

    h.client.setQueryFailure('getPlugins', { failed: 'refused', refusal: 'No load order has been received.' });
    await h.tree.facts.reconciled([]);

    expect(chevrons()).toEqual([Collapsed, Collapsed, None]);
  });
});

describe('PluginsTreeProvider — an enabled line no file answers to', () => {
  const lineOnly = plugin({ name: 'Gone.esp', line: 0, origin: 'Data/', path: undefined });
  const collapsibleStateWith = async (dataFolderPlugins: InstanceValue['dataFolderPlugins']) => {
    const { tree } = makeTree([], { instance: new FakeInstance({ ...valueOf([lineOnly]), dataFolderPlugins }) });
    const [row] = await tree.getChildren();
    return tree.getTreeItem(present(row, 'the sole row')).collapsibleState;
  };

  it('has no expander once the Data folder is listed without it', async () => {
    expect(await collapsibleStateWith({ kind: 'listed', names: new Set() })).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('keeps its chevron while the Data folder cannot be listed, so the records mEdit holds still show', async () => {
    expect(await collapsibleStateWith({ kind: 'unreadable', reason: 'EACCES' })).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });
});

describe('PluginsTreeProvider — a line a mod\'s manifest names, not restored (plugins.md, A row, Plugin statuses)', () => {
  const gone = (mod: string, ...paths: string[]): ModStatus => status(mod, { gone: paths });
  const statusesAnswering = (...answered: ModStatus[]) => {
    const changed = new EventEmitter<void>();
    const byMod = new Map(answered.map((status) => [status.mod, status]));
    return {
      of: (mod: string) => byMod.get(mod),
      onDidChange: changed.event,
      answer: (status: ModStatus) => { byMod.set(status.mod, status); changed.fire(); },
    };
  };
  const cloneValue = ({ holdsRepository = true, enabled = true, plugins = [plugin({ name: 'Unrestored.esp', origin: 'Data/', path: undefined })] } = {}) => ({
    ...valueOf(plugins),
    mods: [{ kind: 'mod' as const, name: 'Provider', enabled: true }, { kind: 'mod' as const, name: 'Unrestored', enabled }],
    dataFolderPlugins: { kind: 'listed' as const, names: new Set<string>() },
    holdsRepository,
  });
  const decorated = async (tree: PluginsTreeProvider) => {
    const [row] = await tree.getChildren();
    const item = tree.getTreeItem(present(row, 'the sole row'));
    return { description: item.description, icon: item.iconPath, tooltip: item.tooltip };
  };

  it('says not restored, in yellow, on a line no file answers to that a mod\'s manifest names', async () => {
    const tree = pluginsTreeOver(new FakeInstance(cloneValue()), { modStatuses: statusesAnswering(gone('Unrestored', 'Unrestored.esp')) });

    expect(await decorated(tree)).toEqual({
      description: 'not restored',
      icon: new ThemeIcon('warning', new ThemeColor('problemsWarningIcon.foreground')),
      tooltip: 'Unrestored.esp\nUnrestored\nNot restored: its mod\'s manifest names it, and the mod\'s folder lacks it.',
    });
  });

  it('gives as its origin the mod that wins it in mod order, when two enabled mods\' manifests name it', async () => {
    const tree = pluginsTreeOver(new FakeInstance(cloneValue()), {
      modStatuses: statusesAnswering(gone('Unrestored', 'Unrestored.esp'), gone('Provider', 'Unrestored.esp')),
    });

    expect((await decorated(tree)).tooltip).toContain('Unrestored.esp\nProvider\n');
  });

  it('says it once mEdit\'s answer lands after the row is shown', async () => {
    const statuses = statusesAnswering();
    const tree = pluginsTreeOver(new FakeInstance(cloneValue()), { modStatuses: statuses });
    await tree.getChildren();

    statuses.answer(gone('Unrestored', 'Unrestored.esp'));

    expect((await decorated(tree)).description).toBe('not restored');
  });

  it.each([
    ['the instance holds no repository', cloneValue({ holdsRepository: false }), 'Unrestored.esp'],
    ['a file answers to the line', cloneValue({ plugins: [plugin({ name: 'Unrestored.esp', origin: 'Provider' })] }), 'Unrestored.esp'],
    ['the manifest names it only below its folder\'s root', cloneValue(), 'optional/Unrestored.esp'],
    ['only a disabled mod\'s manifest names it', cloneValue({ enabled: false }), 'Unrestored.esp'],
  ])('says nothing of it when %s', async (_, value, named) => {
    const tree = pluginsTreeOver(new FakeInstance(value), { modStatuses: statusesAnswering(gone('Unrestored', named)) });

    expect((await decorated(tree)).description).toBeUndefined();
  });
});

describe('PluginsTreeProvider — a row that holds nothing yet expands to a single still-indexing row', () => {
  it('never asks the record browser before any reconcile has landed, answering "still indexing" instead', async () => {
    const { tree, client } = makeTree([A_ROW()]);
    const [row] = await tree.getChildren();

    const children = await tree.getChildren(row);

    expect(rendered(children)).toEqual(STILL_INDEXING);
    expect(callCount(client, 'getRecordTypes')).toBe(0);
  });
});

describe('PluginsTreeProvider — a reconcile keeps the rows', () => {
  it('hands back the very same row objects, in the same order', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    const before = await h.tree.getChildren();

    await reconcile(h, [held('A.esp'), held('B.esp')]);

    const after = await h.tree.getChildren();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe('PluginsTreeProvider — the conditions a record row reads are its plugin row\'s', () => {
  const weaponOf = (record: RecordSummary) => makeClient({
    recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }], records: { items: [record], total: 1 },
  });

  async function firstRecordUnder(h: Harness, row: PluginsTreeNode) {
    const [group] = await h.tree.getChildren(row);
    const [record] = await h.tree.getChildren(present(group, 'the Weapon group'));
    return { group: present(group, 'the Weapon group'), record: present(record, 'the record row') };
  }

  it('flips a record row on the reconcile after its mod is decompiled and committed, from the rows already read', async () => {
    const client = weaponOf(recordSummary());
    const h = makeTree([plugin({ name: 'A.esp', line: 0 })], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    expect((await firstRecordUnder(h, present(row, 'the A.esp row'))).record.contextValue).toBe('record');
    const reads = client.calls.filter((c) => c.method === 'getRecords').length;

    await reconcile(h, [held('A.esp', { isCompiledPlugin: true })]);
    const [again] = await h.tree.getChildren();

    expect((await firstRecordUnder(h, present(again, 'the A.esp row'))).record.contextValue).toBe('record editable');
    expect(client.calls.filter((c) => c.method === 'getRecords')).toHaveLength(reads);
  });

  const DATA_COPY = held('Fallout4.esm', { origin: 'Data/', isImmutable: true });
  const MOD_COPY = held('Fallout4.esm', { origin: 'ModA', isCompiledPlugin: true });
  const lockedTree = (modCopyWins: boolean) => makeTree(
    [plugin({ name: 'Fallout4.esm', line: null, origin: 'ModA', winning: modCopyWins }), plugin({ name: 'A.esp', line: 0 })],
    { client: weaponOf(recordSummary({ plugin: 'Fallout4.esm', formKey: '000001:Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data/' })),
      loadedWithNoLine: [{ name: 'Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data/' }] });

  it.each([['last', [DATA_COPY, MOD_COPY]], ['first', [MOD_COPY, DATA_COPY]]])(
    'states a locked row the game folder provides by the game folder\'s copy, with the mod\'s copy listed %s',
    async (_order, answer) => {
      const h = lockedTree(false);
      await reconcile(h, [...answer, held('A.esp')]);

      const locked = present((await h.tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');
      const { group, record } = await firstRecordUnder(h, locked);

      expect(locked.origin).toBe('Data/');
      expect([group.contextValue, record.contextValue]).toEqual(['recordType creatable', 'record']);
    });

  it('expands a locked row mEdit names no plugin for at its origin as still indexing', async () => {
    const h = lockedTree(false);
    await reconcile(h, [MOD_COPY, held('A.esp')]);

    const locked = present((await h.tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');

    expect(rendered(await h.tree.getChildren(locked))).toEqual(STILL_INDEXING);
  });

  it.each([['last', [MOD_COPY, DATA_COPY]], ['first', [DATA_COPY, MOD_COPY]]])(
    'states a locked row the game loads from a mod by that mod\'s copy, with the game folder\'s listed %s',
    async (_order, answer) => {
      const h = lockedTree(true);
      await reconcile(h, [...answer, held('A.esp')]);

      const locked = present((await h.tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');
      const { group, record } = await firstRecordUnder(h, locked);

      expect(locked.origin).toBe('ModA');
      expect([group.contextValue, record.contextValue]).toEqual(['recordType editable creatable', 'record editable']);
    });
});

describe('PluginsTreeProvider with the client reporting disconnected', () => {
  it('renders the rows, in load order, the same as if it were connected', async () => {
    const h = makeTree([A_ROW(), B_ROW()], { client: makeDisconnectedClient() });
    await h.tree.facts.reconciled([]);

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

});

describe('PluginsTreeProvider — the message line takes the first message that holds (common.md, States 5; plugins.md, States 1, 5 and 6)', () => {
  const GAME_FOLDER_MESSAGE = "Game folder not found: set modbench.mods.gameFolder. The Toolbox's Game row names each place Modbench looked.";
  const indexFailed = { kind: 'failed', message: 'the record index threw' } as const;

  const withoutGameFolder = (plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]) =>
    new FakeInstance({ ...valueOf(plugins), gameFolder: GAME_FOLDER_NOT_FOUND });

  it('puts the game folder over a failed index', () => {
    const h = makeTree([A_ROW()], { instance: withoutGameFolder([A_ROW()]) });
    h.tree.facts.refused(indexFailed);

    expect(h.tree.viewMessage()).toBe(GAME_FOLDER_MESSAGE);
  });

  it('puts a failed index over no rows', async () => {
    const h = makeTree([]);
    await h.tree.getChildren();
    h.tree.facts.refused(indexFailed);

    expect(h.tree.viewMessage()).toBe('Indexing failed: the record index threw');
  });

  it('takes the failed index off the message line on the next tick that indexes', async () => {
    const h = makeTree([A_ROW()]);
    await h.tree.getChildren();
    h.tree.facts.refused(indexFailed);
    expect(h.tree.viewMessage()).toBe('Indexing failed: the record index threw');

    h.tree.facts.indexed([{ name: 'A.esp', origin: 'SomeMod' }], []);

    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('puts no rows over a record filter that matched nothing', async () => {
    const instance = new FakeInstance(valueOf([A_ROW()]));
    const h = makeTree([], { instance });
    h.tree.setRecordFilterSource('a.sql');
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(h.tree.viewMessage()).toBe('No records match a.sql.');

    instance.publish(valueOf([]));
    await h.tree.getChildren();

    expect(h.tree.viewMessage()).toBe(NO_PLUGINS_MESSAGE);
  });
});

describe('PluginsTreeProvider — a record filter hides a plugin with no matches', () => {
  it('omits a plugin with no matching records from the row set entirely', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);
  });

  it('keeps hidden the row a record filter hid when mEdit becomes unreachable', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);

    h.tree.facts.unreachable('mEdit is stopped.');

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);
  });

  it('keeps a plugin the filter still matches visible and expandable', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    const [row] = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('hides an implicit master row the record filter matches no records of', async () => {
    const h = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data/', hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  const ownCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'Data/', hasMatchingRecords: matches });
  const modCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'ModA', hasMatchingRecords: matches });
  it.each([
    ['hides', 'matches nothing', 'first', [ownCopy(false), modCopy(true)], 0],
    ['hides', 'matches nothing', 'last', [modCopy(true), ownCopy(false)], 0],
    ['shows', 'matches', 'first', [ownCopy(true), modCopy(false)], 1],
    ['shows', 'matches', 'last', [modCopy(false), ownCopy(true)], 1],
  ] as const)('%s a locked row whose own copy %s, with its own copy listed %s', async (_verb, _match, _order, answer, rows) => {
    const h = makeTree(
      [plugin({ name: 'Fallout4.esm', line: null, origin: 'ModA', winning: false })],
      { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [...answer]);

    expect(await h.tree.getChildren()).toHaveLength(rows);
  });

  it('hides no row by the answer for another plugin of its name, when mEdit names none at its origin', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'RenamedMod' })]);
    await reconcile(h, [held('A.esp', { origin: 'SomeOtherMod', hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  it('restores a hidden row in its new position when the underlying order changed while it was hidden', async () => {
    const instance = new FakeInstance(valueOf([A_ROW(), B_ROW()]));
    const h = makeTree([], { instance });
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);

    instance.publish(valueOf([
      plugin({ name: 'B.esp', line: 0 }), plugin({ name: 'A.esp', line: 1 }),
    ]));
    h.client.setQueryAnswer('getPlugins', [held('A.esp'), held('B.esp')]);
    await h.tree.facts.refresh();

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp', 'A.esp']);
  });

  describe('when the fact re-read fails', () => {
    const hiddenByA = async (): Promise<Harness> => {
      const h = makeTree([A_ROW(), B_ROW()]);
      h.tree.setRecordFilterSource('a.sql');
      await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
      h.client.setQueryFailure('getPlugins', { failed: 'refused', refusal: 'No load order has been received.' });
      return h;
    };
    const labels = async (h: Harness) => (await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label);

    it('keeps a row hidden by the filter still in force', async () => {
      const h = await hiddenByA();

      await h.tree.facts.refresh();

      expect(await labels(h)).toEqual(['B.esp']);
    });

    it('shows the row again when the filter was cleared', async () => {
      const h = await hiddenByA();

      h.tree.setRecordFilterSource(undefined);
      await h.tree.facts.refresh();

      expect(await labels(h)).toEqual(['A.esp', 'B.esp']);
    });

    it('shows the row again when another filter replaced the one that hid it', async () => {
      const h = await hiddenByA();

      h.tree.setRecordFilterSource('b.sql');
      await h.tree.facts.refresh();

      expect(await labels(h)).toEqual(['A.esp', 'B.esp']);
    });
  });

});

describe('PluginsTreeProvider — a row expands into the record browser children', () => {
  const withRecords = (client: InMemoryMEditClient) => makeTree([A_ROW()], { client });

  it('reads the row\'s own plugin of a shared filename, and every row beneath it carries that plugin', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummary({ plugin: 'Shared.esp', formKey: '000001:Shared.esp', origin: 'ModB' })], total: 1 },
    });
    const h = makeTree([
      plugin({ name: 'Shared.esp', line: 0, origin: 'ModA', winning: false }),
      plugin({ name: 'Shared.esp', line: 0, origin: 'ModB' }),
    ], { client });
    await reconcile(h, [held('Shared.esp', { origin: 'ModA' }), held('Shared.esp', { origin: 'ModB' })]);
    const [row] = await h.tree.getChildren();

    const group = present((await h.tree.getChildren(row))[0], 'the Weapon group');
    const record = present((await h.tree.getChildren(group))[0], 'the record row');

    expect(client.calls.filter((c) => c.method === 'getRecordTypes' || c.method === 'getRecords').map((c) => c.args))
      .toEqual([[{ name: 'Shared.esp', origin: 'ModB' }], [{ name: 'Shared.esp', origin: 'ModB' }, 'weap', 0, expect.any(Number)]]);
    expect(record.command?.arguments?.[0]).toEqual({ argument: { kind: 'record', formKey: '000001:Shared.esp', plugin: { name: 'Shared.esp', origin: 'ModB' } } });
  });

  it('renders a child tree item through the record browser, not the row path', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 5, displayName: 'Weapon' }] });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    const [recordType] = await h.tree.getChildren(row);
    const item = present(recordType, "the row's sole record-type child");

    expect(h.tree.getTreeItem(item)).toBe(item);
    expect(h.tree.getTreeItem(item).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('forwards the record browser change events', () => {
    const h = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    h.tree.onDidChangeTreeData((e) => fired.push(e));

    h.records.refresh();

    expect(fired).toEqual([undefined]);
  });

  it('forwards the load order own change events', () => {
    const { tree, instance } = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    instance.publish(instance.value);

    expect(fired).toEqual([undefined]);
  });
});

describe('PluginsTreeProvider — a record row is identified by its kind, its plugin and its FormKey', () => {
  const SHARED = '000801:Fallout4.esm';
  const everyKindOfRecord = () => makeClient({
    recordTypes: [
      { type: 'weap', count: 1, displayName: 'Weapon' },
      { type: 'wrld', count: 1, displayName: 'Worldspace' },
      { type: 'cell', count: 1, displayName: 'Cell' },
    ],
    records: { items: [recordSummary({ formKey: SHARED })], total: 1 },
    worldspaces: [{ workingTreeState: 'None', formKey: SHARED, editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
    worldspaceBlocks: {
      topCells: [{ workingTreeState: 'None', formKey: '000802:Fallout4.esm', isPersistentWorldspaceCell: true, hasChildren: true, hasParseFailure: false }],
      blocks: [],
    },
    cellChildRecords: {
      persistent: [{ workingTreeState: 'None', formKey: '000803:Fallout4.esm', editorId: 'DoorRef', recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    },
    interiorCells: [{
      number: 0, hasParseFailure: false,
      subBlocks: [{ number: 0, hasParseFailure: false, cells: [{ workingTreeState: 'None', formKey: '000804:Fallout4.esm', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }],
    }],
  });

  async function everyRow(tree: PluginsTreeProvider, under?: PluginsTreeNode): Promise<PluginsTreeNode[]> {
    const children = await tree.getChildren(under);
    const expandable = children.filter((child) => tree.getTreeItem(child).collapsibleState !== vscode.TreeItemCollapsibleState.None);
    const below = await Promise.all(expandable.map((child) => everyRow(tree, child)));
    return [...children, ...below.flat()];
  }

  async function heldTree(plugins: (LoadOrderPlugin | LoadOrderPluginLine)[], instance?: FakeInstance): Promise<Harness> {
    const h = makeTree(plugins, { client: listsForThePluginAsked(everyKindOfRecord()), instance });
    await reconcile(h, plugins.map((p) => held(p.name, { origin: p.origin })));
    return h;
  }

  const RECORD_KINDS = new Set(['record', 'worldspace', 'cell', 'placed']);
  const recordRows = (rows: PluginsTreeNode[]) => rows.filter((row) => RECORD_KINDS.has(row.kind));

  it('gives every record, worldspace, cell and placed reference row an identity, and no two rows one', async () => {
    const { tree } = await heldTree([A_ROW(), B_ROW()]);

    const rows = await everyRow(tree);
    const ids = rows.flatMap((row) => (row.id === undefined ? [] : [row.id]));

    expect(recordRows(rows).map((row) => row.kind).sort()).toEqual(
      ['cell', 'cell', 'cell', 'cell', 'placed', 'placed', 'record', 'record', 'worldspace', 'worldspace']);
    expect(recordRows(rows).every((row) => row.id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds every row, at every level, collapsed', async () => {
    const { tree } = await heldTree([A_ROW(), plugin({ name: 'Off.esp', line: 1, enabled: false })]);

    const rows = await everyRow(tree);
    const states = rows.map((row) => tree.getTreeItem(row).collapsibleState);

    expect([...new Set(rows.map((row) => row.kind))].sort()).toEqual([
      'cell', 'interiorBlock', 'interiorSubBlock', 'placed', 'placedGroup', 'plugin', 'record', 'recordType', 'worldspace',
    ]);
    expect(states.filter((state) => state === vscode.TreeItemCollapsibleState.Expanded)).toEqual([]);
  });

  it('keeps a record row\'s identity when its plugin\'s rows are asked for again', async () => {
    const { tree } = await heldTree([A_ROW()]);

    const first = recordRows(await everyRow(tree)).map((row) => row.id);
    const again = recordRows(await everyRow(tree)).map((row) => row.id);

    expect(again).toEqual(first);
  });

  it('gives a record under the plugin of the same name from another origin another identity', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', line: 0, origin: 'ModA' })]));
    const h = await heldTree([plugin({ name: 'A.esp', line: 0, origin: 'ModA' })], instance);
    const { tree } = h;
    const fromModA = recordRows(await everyRow(tree)).map((row) => row.id);

    instance.publish(valueOf([plugin({ name: 'A.esp', line: 0, origin: 'ModB' })]));
    await reconcile(h, [held('A.esp', { origin: 'ModB' })]);
    const fromModB = recordRows(await everyRow(tree)).map((row) => row.id);

    expect(fromModB).toHaveLength(fromModA.length);
    expect(fromModB.filter((id) => fromModA.includes(id))).toEqual([]);
  });
});

async function rowItem(h: Harness, index = 0): Promise<vscode.TreeItem> {
  const rows = await h.tree.getChildren();
  return h.tree.getTreeItem(present(rows[index], `row at index ${index}`));
}

function tooltipAsString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected a string, got ${String(value)}`);
  return value;
}

describe('PluginsTreeProvider — the row states its conditions', () => {
  const flags = async (h: Harness, index = 0): Promise<string[]> => String((await rowItem(h, index)).contextValue).split(' ');

  it('states an editable plugin in a source mod', async () => {
    const h = makeTree([A_ROW()], { instance: new FakeInstance({ ...valueOf([A_ROW()]), listedSourceMods: new Set(['SomeMod']) }) });
    await reconcile(h, [held('A.esp', { isCompiledPlugin: true })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inSourceMod', 'compiledPlugin', 'editable']);
  });

  it('states a disabled line', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'SomeMod', enabled: false })]);
    await reconcile(h, [held('A.esp')]);

    expect(await flags(h)).toEqual(['plugin', 'disabled', 'inNonSourceMod', 'nonCompiledPlugin']);
  });
});

describe('PluginsTreeProvider — a plugin row\'s click', () => {
  it('does nothing on a disabled plugin but select it', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'SomeMod', enabled: false })]);

    expect((await rowItem(h)).command).toBeUndefined();
  });
});

describe('PluginsTreeProvider — read-only tooltip', () => {

  it('never adds a read-only line to the locked row — its tooltip is the one sentence alone', async () => {
    const h = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data/', isImmutable: true })]);

    expect((await rowItem(h)).tooltip).toBe(
      "This plugin can't be disabled or moved (enforced by the game).");
  });
});

describe('PluginsTreeProvider — master-issue decoration', () => {
  const withIssues = (h: Harness, issues: string[] | null) => reconcile(h, [held('A.esp', { missingMasters: issues })]);

  it('never touches collapsibleState — AC2, and the leading line stays the checkbox alone', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    const item = await rowItem(h);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.checkboxState).toBe(vscode.TreeItemCheckboxState.Checked);
  });

  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);
    expect((await rowItem(h)).tooltip).toContain('Missing master');

    await reconcile(h, [held('A.esp', { isCompiledPlugin: true })]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toEqual(new ThemeIcon('blank'));
    expect(item.description).toBeUndefined();
  });
});

describe('PluginsTreeProvider — load-failure decoration', () => {
  it('never abandons the row: it stays collapsible, but expands to the error node — it will never be indexed', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    expect((await rowItem(h)).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);
    expect(children.map(c => c.contextValue)).toEqual(['error']);
    expect(present(children[0], 'the error row').tooltip).toBe('Malformed record');
  });
});

describe('PluginsTreeProvider fact refresh', () => {
  it('re-renders without rebuilding the rows', async () => {
    const h = makeTree([A_ROW()]);
    const before = await h.tree.getChildren();
    const heard: unknown[] = [];
    h.tree.onDidChangeTreeData(() => heard.push(true));

    await h.tree.facts.refresh();

    expect(heard).toHaveLength(1);
    expect((await h.tree.getChildren())[0]).toBe(before[0]);
  });
});

describe('PluginsTreeProvider — a name under two origins joins to the row own origin, replies listing the row\'s own plugin first so a name-only join would answer with the other', () => {
  const SHARED_ROW = () => plugin({ name: 'Shared.esp', line: 0, origin: 'ModA' });

  it('badges the row from its own plugin master issues, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', missingMasters: ['AMaster.esm'] }),
      held('Shared.esp', { origin: 'ModB', missingMasters: ['BMaster.esm'] }),
    ]);

    const tooltip = tooltipAsString((await rowItem(h)).tooltip);
    expect(tooltip).toContain('Missing masters: AMaster.esm');
    expect(tooltip).not.toContain('BMaster.esm');
  });
});

describe('PluginsTreeProvider — the facts are pulled once and held', () => {
  it('reads the plugin list and the malformed-plugin scan once per reconcile, not once per rendered row', async () => {
    const h = makeTree([A_ROW(), B_ROW(), plugin({ name: 'C.esp', line: 2 })]);
    await reconcile(h, [held('A.esp'), held('B.esp'), held('C.esp')]);

    const rows = await h.tree.getChildren();
    for (const row of rows) h.tree.getTreeItem(row);

    expect(rows).toHaveLength(3);
    expect([callCount(h.client, 'getPlugins'), callCount(h.client, 'getDiagnoses')]).toEqual([1, 1]);
  });

  it('reads nothing at all while rendering children', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);
    for (const child of children) h.tree.getTreeItem(child);

    expect(callCount(h.client, 'getPlugins')).toBe(1);
  });
});

describe('PluginsTreeProvider — the row of a record create wrote', () => {
  const NPCS = { plugin: { name: 'A.esp', origin: 'SomeMod' }, recordType: 'npc_' };
  const NEW_NPC = '000900:A.esp';
  const listing = (...formKeys: string[]) => makeClient({
    recordTypes: [{ type: 'acti', count: 1, displayName: 'Activator' }, { type: 'npc_', count: formKeys.length, displayName: 'Non-Player Character' }],
    records: { items: formKeys.map((formKey) => recordSummary({ formKey, plugin: 'A.esp' })), total: formKeys.length },
  });
  async function heldWith(client: InMemoryMEditClient): Promise<Harness> {
    const rows = [A_ROW(), B_ROW()];
    const h = makeTree(rows, { client });
    await reconcile(h, rows.map((p) => held(p.name, { origin: p.origin })));
    return h;
  }

  it('finds the record\'s row beneath its plugin and its group, once mEdit lists it', async () => {
    const { tree } = await heldWith(listing('000800:A.esp', '000900:A.esp'));

    const row = present(await tree.recordRow(NPCS, NEW_NPC), 'the new record\'s row');

    expect(row.description).toBe('000900:A.esp');
  });

  it('does not count a row it walks past as expanded, though it reads its children', async () => {
    const h = await heldWith(listing('000900:A.esp'));
    const group = present(h.tree.getParent(present(await h.tree.recordRow(NPCS, NEW_NPC), 'the new record\'s row')), 'the group row');
    const groupUri = present(group.resourceUri, 'the group row\'s URI');
    h.records.expandedRow(groupUri);
    h.records.refresh();

    await h.tree.recordRow(NPCS, NEW_NPC);
    const walked = h.records.isExpanded(groupUri);
    await h.tree.getChildren(group);

    expect([walked, h.records.isExpanded(groupUri)]).toEqual([false, true]);
  });

  it('walks from the record\'s row up through its group to its plugin row, and no further', async () => {
    const { tree } = await heldWith(listing('000900:A.esp'));
    const row = present(await tree.recordRow(NPCS, NEW_NPC), 'the new record\'s row');

    const group = present(tree.getParent(row), 'the group row');
    const pluginRow = expectInstanceOf(tree.getParent(group), PluginNode);

    expect([group.label, pluginRow.plugin.name, tree.getParent(pluginRow)]).toEqual(['Non-Player Character', 'A.esp', undefined]);
  });

  it('finds nothing while mEdit does not list the record yet', async () => {
    const { tree } = await heldWith(listing('000800:A.esp'));

    expect(await tree.recordRow(NPCS, NEW_NPC)).toBeUndefined();
  });

  it('finds nothing under a plugin of the same name from another origin', async () => {
    const { tree } = await heldWith(listing('000900:A.esp'));

    expect(await tree.recordRow({ ...NPCS, plugin: { name: 'A.esp', origin: 'OtherMod' } }, NEW_NPC)).toBeUndefined();
  });

  it('finds nothing while the name filter hides its plugin', async () => {
    const { tree } = await heldWith(listing('000900:A.esp'));
    tree.setFilter('B.esp');

    expect(await tree.recordRow(NPCS, NEW_NPC)).toBeUndefined();
  });

  it('finds a worldspace\'s row beneath the Worldspace group, and walks up through it to its plugin row', async () => {
    const { tree } = await heldWith(makeClient({
      recordTypes: [{ type: 'wrld', count: 2, displayName: 'Worldspace' }],
      worldspaces: ['000800:A.esp', '000900:A.esp'].map((formKey) => ({ formKey, hasParseFailure: false, workingTreeState: 'None', hasChildren: true })),
    }));

    const row = present(await tree.recordRow({ ...NPCS, recordType: 'wrld' }, '000900:A.esp'), 'the worldspace row');
    const group = present(tree.getParent(row), 'the Worldspace group');

    expect([row.description, group.label, expectInstanceOf(tree.getParent(group), PluginNode).plugin.name])
      .toEqual(['000900:A.esp', 'Worldspace', 'A.esp']);
  });

  it('finds an interior cell\'s row beneath the Cell group\'s block and sub-block, and walks up through each to its plugin row', async () => {
    const cell = (formKey: string): CellSummary => ({ workingTreeState: 'None', formKey, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false });
    const { tree } = await heldWith(makeClient({
      recordTypes: [{ type: 'cell', count: 2, displayName: 'Cell' }],
      interiorCells: [
        { number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [cell('000800:A.esp')] }] },
        { number: 1, hasParseFailure: false, subBlocks: [{ number: 9, hasParseFailure: false, cells: [cell('000900:A.esp')] }] },
      ],
    }));

    const row = present(await tree.recordRow({ ...NPCS, recordType: 'cell' }, '000900:A.esp'), 'the interior cell row');
    const subBlock = present(tree.getParent(row), 'the sub-block row');
    const block = present(tree.getParent(subBlock), 'the block row');
    const group = present(tree.getParent(block), 'the Cell group');

    expect([row.description, subBlock.label, block.label, group.label, expectInstanceOf(tree.getParent(group), PluginNode).plugin.name])
      .toEqual(['000900:A.esp', 'Sub-Block 9', 'Block 1', 'Cell', 'A.esp']);
  });

  describe('beneath the container it landed in', () => {
    const cell = (formKey: string, hasChildren = false): CellSummary => ({ workingTreeState: 'None', formKey, isPersistentWorldspaceCell: false, hasChildren, hasParseFailure: false });
    const placed = (formKey: string): ChildRecordSummary => ({ workingTreeState: 'None', formKey, recordType: 'refr', hasParseFailure: false });
    const interiorCell = (formKey: string): InteriorCellBlock[] =>
      [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [cell(formKey)] }] }];

    async function rowBeneath(tree: PluginsTreeProvider, parent: PluginsTreeNode, kind: string): Promise<PluginsTreeNode> {
      return present((await tree.getChildren(parent)).find((row) => row.kind === kind), `the ${kind} row`);
    }

    async function ancestry(tree: PluginsTreeProvider, row: PluginsTreeNode): Promise<PluginsTreeNode[]> {
      const parent = tree.getParent(row);
      return parent === undefined ? [] : [parent, ...await ancestry(tree, parent)];
    }

    it('finds a placed reference beneath the empty cell it was created on, through rows the tree shows after the change', async () => {
      const h = await heldWith(makeClient({ recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }], interiorCells: interiorCell('000800:A.esp') }));
      const [pluginRow] = await h.tree.getChildren();
      const group = await rowBeneath(h.tree, present(pluginRow, 'the A.esp row'), 'recordType');
      const subBlock = await rowBeneath(h.tree, await rowBeneath(h.tree, group, 'interiorBlock'), 'interiorSubBlock');
      const shownBefore = await rowBeneath(h.tree, subBlock, 'cell');
      h.client.setQueryAnswer('getCellChildRecords', { persistent: [], temporary: [placed(NEW_NPC)] });
      h.records.refresh();

      const row = present(await h.tree.recordRow({ container: shownBefore }, NEW_NPC), 'the new placed reference\'s row');
      const above = await ancestry(h.tree, row);

      expect(row.kind).toBe('placed');
      expect(above.map((r) => [r.kind, r.label])).toEqual([
        ['placedGroup', 'Temporary'], ['cell', '000800:A.esp'], ['interiorSubBlock', 'Sub-Block 0'], ['interiorBlock', 'Block 0'],
        ['recordType', 'Cell'], ['plugin', 'A.esp'],
      ]);
      expect(above.filter((r) => [shownBefore, subBlock, group].includes(r))).toEqual([]);
    });

    it('finds a new exterior cell beneath its worldspace\'s block and sub-block', async () => {
      const h = await heldWith(makeClient({
        recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
        worldspaces: [{ workingTreeState: 'None', formKey: '000800:A.esp', hasParseFailure: false, hasChildren: false }],
      }));
      const [pluginRow] = await h.tree.getChildren();
      const worldspace = await rowBeneath(h.tree, await rowBeneath(h.tree, present(pluginRow, 'the A.esp row'), 'recordType'), 'worldspace');
      h.client.setQueryAnswer('getWorldspaceBlocks', {
        topCells: [], blocks: [{ x: 0, y: -1, hasParseFailure: false, subBlocks: [{ x: 1, y: -2, hasParseFailure: false, cells: [cell(NEW_NPC)] }] }],
      });
      h.records.refresh();

      const row = present(await h.tree.recordRow({ container: worldspace }, NEW_NPC), 'the new cell row');

      expect((await ancestry(h.tree, row)).slice(0, 3).map((r) => r.label)).toEqual(['Sub-Block 1, -2', 'Block 0, -1', '000800:A.esp']);
    });

    it('finds nothing once the name filter hides the container\'s plugin', async () => {
      const h = await heldWith(makeClient({
        recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }], interiorCells: interiorCell('000800:A.esp'),
        cellChildRecords: { persistent: [placed(NEW_NPC)], temporary: [] },
      }));
      const [pluginRow] = await h.tree.getChildren();
      const group = await rowBeneath(h.tree, present(pluginRow, 'the A.esp row'), 'recordType');
      const subBlock = await rowBeneath(h.tree, await rowBeneath(h.tree, group, 'interiorBlock'), 'interiorSubBlock');
      const cellRow = await rowBeneath(h.tree, subBlock, 'cell');
      h.tree.setFilter('B.esp');

      expect(await h.tree.recordRow({ container: cellRow }, NEW_NPC)).toBeUndefined();
    });
  });

  it('never expands a record row while it looks, since what a record holds is not its group\'s', async () => {
    const h = await heldWith(makeClient({
      recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }],
      interiorCells: [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells: [
        { workingTreeState: 'None', formKey: '000800:A.esp', isPersistentWorldspaceCell: false, hasChildren: true, hasParseFailure: false },
      ] }] }],
    }));

    expect(await h.tree.recordRow({ ...NPCS, recordType: 'cell' }, NEW_NPC)).toBeUndefined();
    expect(callCount(h.client, 'getCellChildRecords')).toBe(0);
  });
});
