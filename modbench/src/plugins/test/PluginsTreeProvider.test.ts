import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginsDrop } from '../../pluginsCommands/plugins';
import { buildLoadOrderRows, type LoadOrderPlugin, type LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import { FileConflictLookup, modOrigin } from '../../instanceLoader/fileConflictIndex';
import type { PluginAddress } from '../../wire/pluginAddress';
import type { InstanceValue } from '../../instanceLoader/instance';
import {
  type PluginDiagnosisReport, type PluginLoadFailure, type PluginMetadata, type RecordPage,
  type WorldspaceSummary, type InteriorCellBlock, type RecordSummary, type CellChildRecords,
  type ContainerChildSummary, type CellSummary, type ChildRecordSummary,
} from '../../client';
import type { WorldspaceBlocks } from '../../client/apiClient';
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
      executeCommand: (id: string, plugins: PluginAddress[], drop: PluginsDrop) => {
        if (id === 'modbench.plugin.move') moveCommands.push({ plugins, drop });
        return Promise.resolve();
      },
    },
  };
});

import * as vscode from 'vscode';
import {
  PluginsTreeProvider, PluginNode, ImplicitMasterNode, NO_PLUGINS_MESSAGE,
  type PluginsTreeNode,
} from '../PluginsTreeProvider';
import { RecordBrowser } from '../RecordBrowser';
import { pluginsTreeOver } from './pluginsTreeOver';
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
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    pluginsLoadedWithNoLine: pluginsLoadedWithNoLine?.map((p) => (typeof p === 'string' ? { name: p, origin: 'Data/' } : p)),
    plugins, paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map(mods.map((m) => [m, `/instance/mods/${m}`])) },
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
    recordCount: 0,
    isImmutable: false,
    origin: 'SomeMod',
    masterIssues: [],
    inLoadOrder: true,
    hasMatchingRecords: true,
    isTracked: false,
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

function diagnosis(pluginName: string, text: string, origin = 'SomeMod'): PluginDiagnosisReport {
  return { plugin: pluginName, origin, defectClass: 'fixed-size-subrecord-short', message: text, text };
}

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
  logged: { level: string; msg: string }[];
}

function makeTree(
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
  extra: Partial<{
    instance: FakeInstance;
    client: InMemoryMEditClient;
    publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
    publishChangedOutside: ConstructorParameters<typeof PluginsTreeProvider>[0]['publishChangedOutside'];
    dataFolderFile: (name: string) => string | undefined;
    loadedWithNoLine: readonly (string | PluginAddress)[];
  }> = {},
): Harness {
  const instance = extra.instance ?? new FakeInstance(valueOf(plugins, extra.loadedWithNoLine));
  const client = extra.client ?? makeClient();
  const records = new RecordBrowser(client);
  const logged: { level: string; msg: string }[] = [];
  const tree = pluginsTreeOver(instance, {
    client, records,
    log: (level, msg) => logged.push({ level, msg }),
    ...(extra.publishDiagnoses && { publishDiagnoses: extra.publishDiagnoses }),
    ...(extra.publishChangedOutside && { publishChangedOutside: extra.publishChangedOutside }),
    ...(extra.dataFolderFile && { dataFolderFile: extra.dataFolderFile }),
  });
  return { tree, client, records, instance, logged };
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

  it('carries the origin of the plugin the row stands for (ADR-0012)', () => {
    expect(new PluginNode({ name: 'A.esp', enabled: true }, 'WinnerMod').origin).toBe('WinnerMod');
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

  it('rows exactly match the fixture value, in file order — not a re-derivation', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Zed.esp', line: 0, enabled: true }),
      plugin({ name: 'Aardvark.esp', line: 1, enabled: false }),
    ]);
    const rows = await tree.getChildren();
    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Zed.esp', 'Aardvark.esp']);
  });

  it('carries each row\'s own origin from the Instance value', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', line: 0, origin: 'ModA' }),
      plugin({ name: 'B.esp', line: 1, origin: 'overwrite/' }),
    ]);
    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);
    expect(rows.map((r) => r.origin)).toEqual(['ModA', 'overwrite/']);
  });

  it('an overridden plugin of a listed name renders no row of its own', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', line: 0, origin: 'Winner', winning: true }),
      plugin({ name: 'Base.esp', line: 0, origin: 'Loser', winning: false }),
    ]);
    const rows = (await tree.getChildren()).filter((n) => n instanceof PluginNode);
    expect(rows).toHaveLength(1);
  });

  it('an unlisted plugin (line: null) gets no row', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', line: 0 }),
      plugin({ name: 'Unlisted.esp', line: null, winning: true }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Base.esp']);
  });

  it('still renders a row for a listed name no mod provides, when the Data folder is unresolved', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', line: 0, origin: 'Data/', path: '/unresolved/Fallout4.esm' }),
      plugin({ name: 'Mod.esp', line: 1, origin: 'SomeMod' }),
    ], { dataFolderFile: () => undefined });

    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm', 'Mod.esp']);
  });

  it('renders a row for a LoadOrderPluginLine (path: undefined)', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', line: 0, origin: 'Data/', path: undefined }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm']);
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

  it('renders a plugin plugins.txt names twice as one row, at its first line', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', line: 0 }), plugin({ name: 'B.esp', line: 1 }), plugin({ name: 'a.ESP', line: 2 }),
    ]);

    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);

    expect(rows.map((r) => r.plugin.name)).toEqual(['A.esp', 'B.esp']);
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

  it('a drop onto a row asks for the block to land before that row', async () => {
    await drag(['A.esp'], 'D.esp');
    expect(moves()).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('a drop names each dragged row by its origin and file name', async () => {
    await drag(['A.esp'], 'D.esp');
    expect(moveCommands.map(({ plugins }) => plugins)).toEqual([[{ name: 'A.esp', origin: 'SomeMod' }]]);
  });

  it('a drop fires nothing before the read lands', async () => {
    const { fired } = await drag(['A.esp'], 'D.esp');
    expect(fired).toBe(false);
  });

  it('drop past the last row (undefined target) asks for the winning end', async () => {
    await drag(['B.esp'], undefined);
    expect(moves()).toEqual([{ names: ['B.esp'], drop: { kind: 'winningEnd' } }]);
  });

  it('a drop on a locked row asks for the losing end', async () => {
    const { tree } = makeTree(fixturePlugins(), { loadedWithNoLine: ['Fallout4.esm'] });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('B.esp')], dt, IGNORED_TOKEN);
    await tree.handleDrop(new ImplicitMasterNode('Fallout4.esm', 'Data/'), dt, IGNORED_TOKEN);
    expect(moves()).toEqual([{ names: ['B.esp'], drop: { kind: 'losingEnd' } }]);
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

  it('contiguous multi-selection moves as one block, named in the drag order', async () => {
    await drag(['B.esp', 'C.esp', 'D.esp'], 'A.esp');
    expect(moves())
      .toEqual([{ names: ['B.esp', 'C.esp', 'D.esp'], drop: { kind: 'before', name: 'A.esp' } }]);
  });

  it('a drop on a row being dragged asks for nothing', async () => {
    await drag(['A.esp', 'C.esp'], 'C.esp');
    expect(moves()).toEqual([]);
  });

  it('non-contiguous multi-selection names every dragged row, in one drop', async () => {
    await drag(['A.esp', 'C.esp', 'E.esp'], 'D.esp');
    expect(moves())
      .toEqual([{ names: ['A.esp', 'C.esp', 'E.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
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

  it('a drop still asks for the move with the client reporting disconnected', async () => {
    const tree = pluginsTreeOver(new FakeInstance(valueOf(fixturePlugins())), { client: makeDisconnectedClient() });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);

    await tree.handleDrop(node('D.esp'), dt, IGNORED_TOKEN);

    expect(moves()).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
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
      [plugin({ name: 'Base.esp', line: 0, origin: 'OtherMod' })], { dataFolderFile: (name) => `/game/Data/${name}` });
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'Base.esp', enabled: true }, 'SomeMod'))).toBeUndefined();
  });

  it('resolves a locked row the game loads from a mod to that mod\'s copy, not the game folder\'s', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Fallout4.esm', line: 0, origin: 'SomeMod', path: '/instance/mods/SomeMod/Fallout4.esm' })],
      { dataFolderFile: (name) => `/game/Data/${name}`, loadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'SomeMod' }] });
    const locked = await lockedRowOf(tree);

    expect(locked.origin).toBe('SomeMod');
    expect(await tree.resolvePluginPath(locked)).toBe('/instance/mods/SomeMod/Fallout4.esm');
  });

  it('resolves a locked row no mod provides to the game folder\'s copy', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Mod.esp', line: 0 })],
      { dataFolderFile: (name) => `/game/Data/${name}`, loadedWithNoLine: ['Fallout4.esm'] });

    expect(await tree.resolvePluginPath(await lockedRowOf(tree))).toBe('/game/Data/Fallout4.esm');
  });

  it('resolves a locked row to nothing while the game folder is not found', async () => {
    const { tree } = makeTree([], { dataFolderFile: () => undefined });
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

  it('a name the backend calls implicit which plugins.txt also lists renders exactly once, as the implicit row (an .esl the game loads on its own)', async () => {
    const rows = await treeFor([
      plugin({ name: 'Fallout4.esm', line: 0, origin: 'Data/' }),
      plugin({ name: 'ccBGSFO4044-HellfirePowerArmor.esl', line: 1, origin: 'Data/' }),
    ], ['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']).getChildren();

    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']);
    expect(rows.every((r) => r instanceof ImplicitMasterNode)).toBe(true);
  });

  it('renders a plugins.txt line of the same filename from another origin as its own row (ADR-0012)', async () => {
    const rows = await treeFor([plugin({ name: 'Fallout4.esm', line: 0, origin: 'SomeMod' })], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.kind)).toEqual(['implicitMaster', 'plugin']);
  });

  it('matches a plugins.txt line to an implicit name case-insensitively', async () => {
    const rows = await treeFor([plugin({ name: 'FALLOUT4.ESM', line: 0, origin: 'Data/' })], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
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

describe('PluginsTreeProvider — an enabled row is always collapsible', () => {
  it('keeps every row collapsible before any reconcile has ever landed', async () => {
    const { tree } = makeTree([A_ROW(), B_ROW()]);
    for (const row of await tree.getChildren()) {
      expect(tree.getTreeItem(row).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    }
  });

  it('stays collapsible once mEdit starts', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('stays collapsible while a fresh load holds nothing yet', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.facts.indexed([], []);

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('a plugin the load order never reports still gets a chevron', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const rows = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(rows[1], "B.esp's row")).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });
});

describe('PluginsTreeProvider — a disabled plugin row has no expander', () => {
  it('renders TreeItemCollapsibleState.None for a disabled plugin, before any reconcile', async () => {
    const { tree } = makeTree([plugin({ name: 'A.esp', line: 0, enabled: false })]);
    const [row] = await tree.getChildren();

    expect(tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('stays None once mEdit holds the plugin — enabling is what would give it a chevron, not indexing', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, enabled: false })]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('an enabled row beside it still gets a chevron', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', line: 0, enabled: false }),
      plugin({ name: 'B.esp', line: 1, enabled: true }),
    ]);
    const rows = await tree.getChildren();

    expect(tree.getTreeItem(present(rows[0], "A.esp's row")).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
    expect(tree.getTreeItem(present(rows[1], "B.esp's row")).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });
});

describe('PluginsTreeProvider — expanding a row, never an empty list', () => {
  it('never asks the record browser before any reconcile has landed, answering "still indexing" instead', async () => {
    const { tree, client } = makeTree([A_ROW()]);
    const [row] = await tree.getChildren();

    const children = await tree.getChildren(row);

    expect(rendered(children)).toEqual(STILL_INDEXING);
    expect(callCount(client, 'getRecordTypes')).toBe(0);
  });

  it('reads no plugin facts before a reconcile', async () => {
    const { tree, client } = makeTree([A_ROW()]);
    const [row] = await tree.getChildren();
    tree.getTreeItem(present(row, 'the sole row'));
    expect(callCount(client, 'getPlugins')).toBe(0);
  });

  it('a plugin the load order does not hold yet expands to a "still indexing" node', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const rows = await h.tree.getChildren();

    expect(rendered(await h.tree.getChildren(rows[1]))).toEqual(STILL_INDEXING);
  });

  it('applyIndexed lets a landed plugin expand into records, and leaves an un-landed one still indexing, with no plugin facts read', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW(), B_ROW()], { client });
    const rows = await h.tree.getChildren();

    h.tree.facts.indexed([{ name: 'A.esp', origin: 'SomeMod' }], []);

    expect((await h.tree.getChildren(rows[0])).map(c => c.label)).toEqual(['Weapon']);
    expect(rendered(await h.tree.getChildren(rows[1]))).toEqual(STILL_INDEXING);
    expect(callCount(h.client, 'getPlugins')).toBe(0);
  });

  it('expanding after a load order was held and the client then refuses answers with one error node', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    disconnect(h.client);

    const children = await h.tree.getChildren(row);
    expect(children.map(c => c.contextValue)).toEqual(['error']);
  });

  it('a reconcile whose plugin read fails leaves the held row its chevron and its records, never a row still indexing', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.client.setQueryFailure('getPlugins', new Error('No load order has been received.'));
    await h.tree.facts.reconciled([]);

    expect(h.tree.getTreeItem(present(row, 'the A.esp row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect((await h.tree.getChildren(row)).map(c => c.label)).toEqual(['Weapon']);
  });

  it('expanding while a fresh load holds nothing yet answers with one node, never an empty list', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.facts.indexed([], []);

    expect(rendered(await h.tree.getChildren(row))).toEqual(STILL_INDEXING);
  });
});

describe('PluginsTreeProvider — reconcile and clear keep row identity, and still fire updates', () => {
  it('hands back the very same row objects, in the same order', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    const before = await h.tree.getChildren();

    await reconcile(h, [held('A.esp'), held('B.esp')]);

    const after = await h.tree.getChildren();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('fires a change event so badges and children can refresh', async () => {
    const h = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    h.tree.onDidChangeTreeData((e) => fired.push(e));

    await reconcile(h, [held('A.esp')]);

    expect(fired.length).toBeGreaterThan(0);
  });

  it('keeps the load order rows intact when a fresh load starts', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp')]);
    const before = await h.tree.getChildren();

    h.tree.facts.indexed([], []);

    expect(await h.tree.getChildren()).toEqual(before);
  });

  it.each([
    ['after', [held('Shared.esp', { origin: 'ModA', isImmutable: true, isTracked: true }), held('Shared.esp', { origin: 'ModB' })]],
    ['before', [held('Shared.esp', { origin: 'ModB' }), held('Shared.esp', { origin: 'ModA', isImmutable: true, isTracked: true })]],
  ])("never marks a plugin's records read-only or tracked for another plugin of the same name, listed %s it", async (_order, answer) => {
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummary({ plugin: 'Shared.esp', formKey: '000001:Shared.esp', origin: 'ModB' })], total: 1 },
    });
    const h = makeTree([plugin({ name: 'Shared.esp', line: 0, origin: 'ModB' })], { client });
    await reconcile(h, answer);

    const [row] = await h.tree.getChildren();
    const [group] = await h.tree.getChildren(present(row, 'the Shared.esp row'));
    const [record] = await h.tree.getChildren(present(group, 'the Weapon group'));

    expect(present(record, 'the record row').contextValue).toBe('record untracked editable');
    expect(present(group, 'the Weapon group').contextValue).toBe('recordType untracked editable creatable');
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

  it('states an override record under a tracked, editable plugin tracked and editable', async () => {
    const client = weaponOf(recordSummary({ formKey: '000001:Fallout4.esm' }));
    const h = makeTree([plugin({ name: 'A.esp', line: 0 })], { client });
    await reconcile(h, [held('A.esp', { isTracked: true }), held('Fallout4.esm', { origin: 'Data/', isImmutable: true })]);

    const [row] = await h.tree.getChildren();
    const { record } = await firstRecordUnder(h, present(row, 'the A.esp row'));

    expect(record.contextValue).toBe('record tracked editable');
  });

  it('states every row of a plugin whose plugin source is unreadable tracked and not editable, and says why on the plugin row', async () => {
    const client = weaponOf(recordSummary());
    const h = makeTree([plugin({ name: 'A.esp', line: 0 })], { client });
    await reconcile(h, [held('A.esp', { isTracked: true, pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } })]);

    const [row] = await h.tree.getChildren();
    const { group, record } = await firstRecordUnder(h, present(row, 'the A.esp row'));

    expect(h.tree.getTreeItem(present(row, 'the A.esp row')).description).toBe('plugin source unreadable');
    expect([group.contextValue, record.contextValue]).toEqual(['recordType tracked creatable', 'record tracked']);
  });

  it('flips a record row on the reconcile that tracks its plugin, from the rows already read', async () => {
    const client = weaponOf(recordSummary());
    const h = makeTree([plugin({ name: 'A.esp', line: 0 })], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    expect((await firstRecordUnder(h, present(row, 'the A.esp row'))).record.contextValue).toBe('record untracked editable');
    const reads = client.calls.filter((c) => c.method === 'getRecords').length;

    await reconcile(h, [held('A.esp', { isTracked: true })]);
    const [again] = await h.tree.getChildren();

    expect((await firstRecordUnder(h, present(again, 'the A.esp row'))).record.contextValue).toBe('record tracked editable');
    expect(client.calls.filter((c) => c.method === 'getRecords')).toHaveLength(reads);
  });

  const DATA_COPY = held('Fallout4.esm', { origin: 'Data/', isImmutable: true });
  const MOD_COPY = held('Fallout4.esm', { origin: 'ModA', isTracked: true });
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
      expect([group.contextValue, record.contextValue]).toEqual(['recordType untracked creatable', 'record untracked']);
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
      expect([group.contextValue, record.contextValue]).toEqual(['recordType tracked editable creatable', 'record tracked editable']);
    });
});

describe('PluginsTreeProvider with the client reporting disconnected', () => {
  it('actually asks the client and observes the failure', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });

    expect(await h.tree.facts.reconciled([])).toBeUndefined();

    expect(callCount(h.client, 'getPlugins')).toBeGreaterThan(0);
  });

  it('renders the rows, in load order, the same as if it were connected', async () => {
    const h = makeTree([A_ROW(), B_ROW()], { client: makeDisconnectedClient() });
    await h.tree.facts.reconciled([]);

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('expanding a row yields exactly one error node', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await h.tree.facts.reconciled([]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(children.map(c => c.contextValue)).toEqual(['error']);
  });

  it('names the reason the read failed, not a generic "not connected" message', async () => {
    const client = makeClient();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));
    const h = makeTree([A_ROW()], { client });
    await h.tree.facts.reconciled([]);
    const [row] = await h.tree.getChildren();

    const [child] = await h.tree.getChildren(row);

    expect(present(child, 'the error row').tooltip).toBe('ECONNREFUSED');
  });

  it('tooltips a row with its file name and mod', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await h.tree.facts.reconciled([]);
    const [row] = await h.tree.getChildren();

    const item = h.tree.getTreeItem(present(row, 'the sole row'));
    expect(item.tooltip).toBe('A.esp\nSomeMod');
  });

  it('is distinguishable from a "still indexing" row', async () => {
    const disconnected = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await disconnected.tree.facts.reconciled([]);
    const [discRow] = await disconnected.tree.getChildren();
    const [discChild] = await disconnected.tree.getChildren(discRow);

    const indexing = makeTree([A_ROW(), B_ROW()]);
    indexing.tree.facts.indexed([{ name: 'A.esp', origin: 'SomeMod' }], []);
    const rows = await indexing.tree.getChildren();
    const [idxChild] = await indexing.tree.getChildren(rows[1]);

    expect(present(discChild, 'the error row').contextValue).toBe('error');
    expect(rendered([present(idxChild, 'the indexing row')])).toEqual(STILL_INDEXING);
  });
});

describe("PluginsTreeProvider — the load order's own refusal", () => {
  const heldElsewhere = { kind: 'heldElsewhere' as const, message: 'another Modbench window holds this instance' };
  const failed = { kind: 'failed' as const, message: 'the reconcile threw something unexpected' };

  it('expands a row to the error row naming a heldElsewhere refusal, before any reconcile has landed', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();

    h.tree.facts.refused(heldElsewhere);
    const children = await h.tree.getChildren(row);

    expect(children).toHaveLength(1);
    expect(present(children[0], 'the error row').tooltip).toBe(heldElsewhere.message);
  });

  it("a heldElsewhere refusal overrides an already-held plugin's records too, not only the unindexed rows", async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.facts.refused(heldElsewhere);
    const children = await h.tree.getChildren(row);

    expect(children.map(c => c.contextValue)).toEqual(['error']);
  });

  it("a failed refusal names the failure on the view's message line until the next reconcile ticks", async () => {
    const h = makeTree([A_ROW()]);
    await h.tree.getChildren();

    h.tree.facts.refused(failed);
    expect(h.tree.viewMessage()).toBe(`Indexing failed: ${failed.message}`);

    h.tree.facts.indexed([], []);
    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('leaves the row set and each row\'s status alone — the tree does not change shape', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp', { masterIssues: ['C.esp'] })]);
    const before = await h.tree.getChildren();
    const statusBefore = h.tree.getTreeItem(present(before[1], "B.esp's row")).description;

    h.tree.facts.refused(heldElsewhere);
    const after = await h.tree.getChildren();

    expect(after).toEqual(before);
    expect(h.tree.getTreeItem(present(after[1], "B.esp's row")).description).toBe(statusBefore);
  });
});

describe('PluginsTreeProvider — the message line takes the first message that holds (common.md, States 5; plugins.md, States 1, 5 and 6)', () => {
  const GAME_FOLDER_MESSAGE = "Game folder not found: set modbench.mods.gameDirectory. The Toolbox's Game row names each place Modbench looked.";
  const indexFailed = { kind: 'failed', message: 'the index threw' } as const;

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

    expect(h.tree.viewMessage()).toBe('Indexing failed: the index threw');
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

describe('PluginsTreeProvider — applyBackendUnreachable', () => {
  it('names the reason on a row, before any reconcile has landed', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();

    h.tree.facts.unreachable('mEdit is disconnected.');
    const children = await h.tree.getChildren(row);

    expect(present(children[0], 'the error row').tooltip).toBe('mEdit is disconnected.');
  });

  it('keeps hidden the row a record filter hid, as no reason to un-narrow a view the user narrowed', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);

    h.tree.facts.unreachable('mEdit is stopped.');

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);
  });

  it('keeps the records behind a held row, and names the reason only on a row the load never reached', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW(), B_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const rows = await h.tree.getChildren();

    h.tree.facts.unreachable('mEdit is stopped.');

    expect((await h.tree.getChildren(rows[0])).map(c => c.label)).toEqual(['Weapon']);
    expect(present((await h.tree.getChildren(rows[1]))[0], 'the error row').tooltip).toBe('mEdit is stopped.');
  });
});

describe('PluginsTreeProvider — a record filter hides a plugin with no matches', () => {
  it('omits a plugin with no matching records from the row set entirely', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);
  });

  it('keeps a plugin the filter still matches visible and expandable', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    const [row] = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  it('keeps every row present and expandable before any answer has landed', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    const rows = await h.tree.getChildren();
    expect(rows).toHaveLength(1);
    expect(h.tree.getTreeItem(present(rows[0], 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
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

  it('restores a hidden plugin immediately, in load order, once the filter clears', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);

    h.client.setQueryAnswer('getPlugins', [held('A.esp'), held('B.esp')]);
    await h.tree.facts.refresh();

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
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

  it('hides a plugin with a missing-master flag while the filter matches none of its records', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      hasMatchingRecords: false,
      masterIssues: ['Ghost.esm'],
    })]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  it('hides a plugin that failed to load while the filter matches none of its records', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  describe('when the fact re-read fails', () => {
    const hiddenByA = async (): Promise<Harness> => {
      const h = makeTree([A_ROW(), B_ROW()]);
      h.tree.setRecordFilterSource('a.sql');
      await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
      h.client.setQueryFailure('getPlugins', new Error('No load order has been received.'));
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

  it('keeps a filter-hidden row hidden while a fresh load is in progress', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(await h.tree.getChildren()).toEqual([]);

    h.tree.facts.indexed([], []);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  it('restores a filter-hidden row once the fresh load lands a new answer', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(await h.tree.getChildren()).toEqual([]);

    await reconcile(h, [held('A.esp')]);

    const rows = await h.tree.getChildren();
    expect(rows).toHaveLength(1);
    expect(h.tree.getTreeItem(present(rows[0], 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });
});

describe('PluginsTreeProvider — a row expands into the record browser children', () => {
  const withRecords = (client: InMemoryMEditClient) => makeTree([A_ROW()], { client });

  it('asks the record browser for that plugin children, by (origin, filename)', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 5, displayName: 'Weapon' }] });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(client.calls).toContainEqual({ method: 'getRecordTypes', args: [{ name: 'A.esp', origin: 'SomeMod' }] });
    expect(children.map(c => [c.label, c.description])).toEqual([['Weapon', '5']]);
  });

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

  it('renders the records under a record type', async () => {
    const record = recordSummary();
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [record], total: 1 },
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    const [recordType] = await h.tree.getChildren(row);

    const records = await h.tree.getChildren(recordType);

    expect(records.map(r => r.label)).toEqual(['TheWeapon']);
  });

  it('renders the worldspace and cell hierarchy under a row', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ workingTreeState: 'None', formKey: 'w:A.esp', editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
      worldspaceBlocks: {
        topCells: [],
        blocks: [{
          x: 0, y: 0, hasParseFailure: false,
          subBlocks: [{
            x: 1, y: 1, hasParseFailure: false,
            cells: [{ workingTreeState: 'None', formKey: 'c:A.esp', editorId: 'TheCell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }],
          }],
        }],
      },
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const [worldspaces] = await h.tree.getChildren(row);
    expect(present(worldspaces, 'the Worldspace group').label).toBe('Worldspace');
    const [worldspace] = await h.tree.getChildren(worldspaces);
    expect(present(worldspace, 'the worldspace row').label).toBe('Commonwealth');
    const [block] = await h.tree.getChildren(worldspace);
    expect(present(block, 'the block row').label).toBe('Block 0, 0');
    const [subBlock] = await h.tree.getChildren(block);
    expect(present(subBlock, 'the sub-block row').label).toBe('Sub-Block 1, 1');
    const [cell] = await h.tree.getChildren(subBlock);
    expect(present(cell, 'the cell row').label).toBe('TheCell');
  });

  it('nests the interior cells in xEdit\'s numbered blocks and sub-blocks', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }],
      interiorCells: [{
        number: 3, hasParseFailure: false,
        subBlocks: [{
          number: 7, hasParseFailure: false,
          cells: [{ workingTreeState: 'None', formKey: 'i:A.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }],
        }],
      }],
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const [interior] = await h.tree.getChildren(row);
    expect(present(interior, 'the Cell group').label).toBe('Cell');
    const [block] = await h.tree.getChildren(interior);
    expect(present(block, 'the block row').label).toBe('Block 3');
    const [subBlock] = await h.tree.getChildren(block);
    expect(present(subBlock, 'the sub-block row').label).toBe('Sub-Block 7');
    const [cell] = await h.tree.getChildren(subBlock);
    expect(present(cell, 'the cell row').label).toBe('Room');
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

  it('renders whatever the record browser returns for a failed fetch, rather than swallowing it', async () => {
    const client = makeClient();
    client.setQueryFailure('getRecordTypes', new Error('boom'));
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(children).toHaveLength(1);
    expect(present(children[0], 'the error row').label).toBe('Failed to load: boom');
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

const rowParts = (item: vscode.TreeItem): [unknown, unknown, unknown] => [item.label, item.description, item.tooltip];

describe('PluginsTreeProvider — groups and records are named and described as xEdit names them', () => {
  async function expandedRow(client: InMemoryMEditClient): Promise<{ h: Harness; groups: PluginsTreeNode[] }> {
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    return { h, groups: await h.tree.getChildren(row) };
  }

  const cell = (overrides: Partial<CellSummary>): CellSummary => ({
    formKey: 'c:A.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, workingTreeState: 'None', ...overrides,
  });

  const inOneSubBlock = (cells: CellSummary[]): InteriorCellBlock[] =>
    [{ number: 0, hasParseFailure: false, subBlocks: [{ number: 0, hasParseFailure: false, cells }] }];

  async function interiorCellsOf(h: Harness, group: PluginsTreeNode | undefined): Promise<PluginsTreeNode[]> {
    const [block] = await h.tree.getChildren(present(group, 'the Cell group'));
    const [subBlock] = await h.tree.getChildren(present(block, 'its sole block'));
    return h.tree.getChildren(present(subBlock, 'its sole sub-block'));
  }

  it('names each group by mEdit\'s type name, in mEdit\'s order, with its record count, worldspaces and cells among the rest', async () => {
    const { groups } = await expandedRow(makeClient({
      recordTypes: [
        { type: 'acti', count: 2, displayName: 'Activator' },
        { type: 'cell', count: 1204, displayName: 'Cell' },
        { type: 'kywd', count: 1, displayName: 'Keyword' },
        { type: 'wrld', count: 3, displayName: 'Worldspace' },
      ],
    }));

    expect(groups.map((g) => [g.label, g.description])).toEqual([
      ['Activator', '2'], ['Cell', '1,204'], ['Keyword', '1'], ['Worldspace', '3'],
    ]);
  });

  it('labels a record by its EditorID or else its FormKey, describes it by its FormKey, and tips it with its name', async () => {
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'weap', count: 2, displayName: 'Weapon' }],
      records: {
        items: [
          recordSummary({ formKey: '000001:A.esp', editorId: 'TheWeapon', fullName: 'Laser Rifle' }),
          recordSummary({ formKey: '000002:A.esp', editorId: null, fullName: null }),
        ],
        total: 2,
      },
    }));

    const records = await h.tree.getChildren(groups[0]);

    expect(records.map(rowParts)).toEqual([
      ['TheWeapon', '000001:A.esp', 'Laser Rifle'],
      ['000002:A.esp', '000002:A.esp', undefined],
    ]);
  });

  it('tips an unreadable record with its name and the reason it could not be read', async () => {
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: {
        items: [recordSummary({ fullName: 'Laser Rifle', hasParseFailure: true, parseDiagnosis: 'bad flag' })],
        total: 1,
      },
    }));

    const [record] = await h.tree.getChildren(groups[0]);

    expect(present(record, 'the unreadable record').tooltip)
      .toBe('Laser Rifle\nThis record could not be read into its document: bad flag');
  });

  it('tips an unreadable worldspace, cell and placed reference with the reason it could not be read', async () => {
    const unreadable = { hasParseFailure: true, parseDiagnosis: 'bad flag' };
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ workingTreeState: 'None', formKey: '000100:A.esp', editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland', hasChildren: true, ...unreadable }],
      worldspaceBlocks: { topCells: [cell({ formKey: '000101:A.esp', editorId: 'TopCell', ...unreadable })], blocks: [] },
      cellChildRecords: {
        persistent: [{ workingTreeState: 'None', formKey: '000301:A.esp', editorId: 'DoorRef', recordType: 'refr', ...unreadable }],
        temporary: [],
      },
    }));
    const [worldspace] = await h.tree.getChildren(groups[0]);
    const [topCell] = await h.tree.getChildren(worldspace);
    const [persistent] = await h.tree.getChildren(topCell);
    const [placed] = await h.tree.getChildren(persistent);

    expect([worldspace, topCell, placed].map((row) => present(row, 'an unreadable row').tooltip)).toEqual([
      'Commonwealth Wasteland\nThis record could not be read into its document: bad flag',
      'This record could not be read into its document: bad flag',
      'This record could not be read into its document: bad flag',
    ]);
  });

  it('names a worldspace as it names a record', async () => {
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'wrld', count: 2, displayName: 'Worldspace' }],
      worldspaces: [
        { workingTreeState: 'None', formKey: '000100:A.esp', editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland', hasParseFailure: false, hasChildren: true },
        { workingTreeState: 'None', formKey: '000200:A.esp', editorId: null, fullName: null, hasParseFailure: false, hasChildren: false },
      ],
    }));

    const worldspaces = await h.tree.getChildren(groups[0]);

    expect(worldspaces.map(rowParts)).toEqual([
      ['Commonwealth', '000100:A.esp', 'Commonwealth Wasteland'],
      ['000200:A.esp', '000200:A.esp', undefined],
    ]);
  });

  it('labels an exterior cell without an EditorID by its grid position, and any other cell as a record', async () => {
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ workingTreeState: 'None', formKey: '000100:A.esp', editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
      worldspaceBlocks: {
        topCells: [cell({ formKey: '000101:A.esp', isPersistentWorldspaceCell: true })],
        blocks: [{
          x: 0, y: -1, hasParseFailure: false,
          subBlocks: [{
            x: 0, y: -1, hasParseFailure: false,
            cells: [
              cell({ formKey: '000102:A.esp', editorId: 'SanctuaryExt', cellX: 12, cellY: -5, fullName: 'Sanctuary Hills' }),
              cell({ formKey: '000103:A.esp', cellX: 3, cellY: -2 }),
            ],
          }],
        }],
      },
    }));
    const [worldspace] = await h.tree.getChildren(groups[0]);
    const [persistentCell, block] = await h.tree.getChildren(worldspace);
    const [subBlock] = await h.tree.getChildren(block);

    const cells = await h.tree.getChildren(subBlock);

    expect(rowParts(present(persistentCell, 'the persistent cell'))).toEqual(['000101:A.esp', '000101:A.esp', undefined]);
    expect(cells.map(rowParts)).toEqual([
      ['SanctuaryExt', '000102:A.esp', 'Sanctuary Hills'],
      ['<  3,  -2>', '000103:A.esp', undefined],
    ]);
  });

  it('names an interior cell as it names a record', async () => {
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'cell', count: 2, displayName: 'Cell' }],
      interiorCells: inOneSubBlock([
        cell({ formKey: '000201:A.esp', editorId: 'Vault111', fullName: 'Vault 111' }),
        cell({ formKey: '000202:A.esp' }),
      ]),
    }));

    const cells = await interiorCellsOf(h, groups[0]);

    expect(cells.map(rowParts)).toEqual([
      ['Vault111', '000201:A.esp', 'Vault 111'],
      ['000202:A.esp', '000202:A.esp', undefined],
    ]);
  });

  it('labels a placed reference without an EditorID by its base record\'s EditorID', async () => {
    const placed = (overrides: Partial<ChildRecordSummary>): ChildRecordSummary => ({
      formKey: 'p:A.esp', recordType: 'refr', hasParseFailure: false, workingTreeState: 'None', ...overrides,
    });
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }],
      interiorCells: inOneSubBlock([cell({ formKey: '000201:A.esp', editorId: 'Vault111', hasChildren: true })]),
      cellChildRecords: {
        persistent: [
          placed({ formKey: '000301:A.esp', editorId: 'DoorRef', baseEditorId: 'VaultDoor', fullName: 'Vault Door' }),
          placed({ formKey: '000302:A.esp', baseEditorId: 'Barrel01', baseFormKey: '000400:A.esp' }),
          placed({ formKey: '000303:A.esp', baseFormKey: '000401:A.esp' }),
        ],
        temporary: [],
      },
    }));
    const [vault] = await interiorCellsOf(h, groups[0]);
    const [persistent] = await h.tree.getChildren(vault);

    const references = await h.tree.getChildren(persistent);

    expect(references.map(rowParts)).toEqual([
      ['DoorRef', '000301:A.esp', 'Vault Door'],
      ['Barrel01', '000302:A.esp', undefined],
      ['000303:A.esp', '000303:A.esp', undefined],
    ]);
  });

  it('names a quest\'s children as it names a record', async () => {
    const child = (overrides: Partial<ContainerChildSummary>): ContainerChildSummary => ({
      formKey: 'd:A.esp', plugin: 'A.esp', origin: 'SomeMod', loadOrderIndex: 0, isWinner: true,
      workingTreeState: 'None', recordType: 'dial', hasContainerChildren: false, isContainer: true, hasParseFailure: false,
      ...overrides,
    });
    const { h, groups } = await expandedRow(makeClient({
      recordTypes: [{ type: 'qust', count: 1, displayName: 'Quest' }],
      records: { items: [recordSummary({ editorId: 'MQ101', hasContainerChildren: true })], total: 1 },
      containerChildren: [
        child({ formKey: '000501:A.esp', editorId: 'MQ101Greeting', fullName: 'Hello' }),
        child({ formKey: '000502:A.esp', recordType: 'dlbr' }),
      ],
    }));
    const [quest] = await h.tree.getChildren(groups[0]);

    const children = await h.tree.getChildren(quest);

    expect(children.map(rowParts)).toEqual([
      ['MQ101Greeting', '000501:A.esp', 'Hello'],
      ['000502:A.esp', '000502:A.esp', undefined],
    ]);
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

  it('states a tracked, editable plugin in a tracked mod', async () => {
    const h = makeTree([A_ROW()], { instance: new FakeInstance({ ...valueOf([A_ROW()]), trackedMods: new Set(['SomeMod']) }) });
    await reconcile(h, [held('A.esp', { isTracked: true })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inTrackedMod', 'tracked', 'editable']);
  });

  it('states a disabled line', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'SomeMod', enabled: false })]);
    await reconcile(h, [held('A.esp')]);

    expect(await flags(h)).toEqual(['plugin', 'disabled', 'inUntrackedMod', 'untracked', 'editable']);
  });

  it('states neither tracked nor editable before mEdit answers', async () => {
    const h = makeTree([A_ROW()]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inUntrackedMod']);
  });
});

describe('PluginsTreeProvider — a plugin row\'s click', () => {
  it('opens the header of an enabled plugin', async () => {
    const h = makeTree([A_ROW()]);

    expect((await rowItem(h)).command?.command).toBe('modbench.record.open');
  });

  it('does nothing on a disabled plugin but select it', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'SomeMod', enabled: false })]);

    expect((await rowItem(h)).command).toBeUndefined();
  });
});

describe('PluginsTreeProvider — read-only tooltip', () => {
  it('carries the base tooltip, with no read-only line, before a load order exists', async () => {
    const h = makeTree([A_ROW()]);

    const tooltip = tooltipAsString((await rowItem(h)).tooltip);
    expect(tooltip).toBe('A.esp\nSomeMod');
  });

  it('tags a read-only plugin tooltip once the load order says so, and gives the row no icon or description', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isImmutable: true })]);

    const item = await rowItem(h);

    expect(item.tooltip).toContain('read-only');
    expect(item.iconPath).toEqual(new ThemeIcon('blank'));
    expect(item.description).toBeUndefined();
  });

  it('stays through a fresh load start, until a new reconcile answers', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isImmutable: true })]);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    h.tree.facts.indexed([], []);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).tooltip).not.toContain('read-only');
  });

  it('never adds a read-only line to the locked row — its tooltip is the one sentence alone', async () => {
    const h = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data/', isImmutable: true })]);

    expect((await rowItem(h)).tooltip).toBe(
      "This plugin can't be disabled or moved (enforced by the game).");
  });
});

describe('PluginsTreeProvider — master-issue decoration', () => {
  const withIssues = (h: Harness, issues: string[] | null) => reconcile(h, [held('A.esp', { masterIssues: issues })]);

  it('flags a row with a master that is not active, in the Problems panel\'s red', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    const item = await rowItem(h);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Missing masters: Ghost.esm');
  });

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

    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toEqual(new ThemeIcon('blank'));
    expect(item.description).toBeUndefined();
  });

  it('keeps the tooltip through a fresh load\'s tick that indexes the plugin', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    h.tree.facts.indexed([{ name: 'A.esp', origin: 'SomeMod' }], []);

    expect((await rowItem(h)).tooltip).toContain('Missing masters: Ghost.esm');
  });

  it('keeps the last master issues through a read taken before the next snapshot is indexed', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    h.client.setQueryAnswer('getPlugins', [held('A.esp', { masterIssues: null })]);
    await h.tree.facts.refresh();

    expect((await rowItem(h)).description).toBe('1 master issue');
  });
});

describe('PluginsTreeProvider — load-failure decoration', () => {
  it('flags a row whose plugin failed to read, with every line of a multi-line reason', async () => {
    const h = makeTree([A_ROW()]);
    const exceptionChainReason = 'InvalidOperationException: Malformed record\nFormatException: bad subrecord at offset 12';
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: exceptionChainReason }]);

    const item = await rowItem(h);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('failed to read');
    expect(item.tooltip).toContain('Failed to read: InvalidOperationException: Malformed record');
    expect(item.tooltip).toContain('FormatException: bad subrecord at offset 12');
  });

  it('shows the failure of a line naming plugins whose names differ only in case, never "Still indexing…"', async () => {
    const files = new FileConflictLookup();
    files.set({ relativePath: 'Foo.esp', winner: '/mods/SomeMod/Foo.esp', winnerOrigin: modOrigin('SomeMod'), providers: [modOrigin('SomeMod')] });
    const modFile = (relativePath: string) => ({ relativePath, path: `/mods/SomeMod/${relativePath}`, sourcePath: `/mods/SomeMod/${relativePath}`, excluded: false, excludedByName: false });
    const rows = buildLoadOrderRows(
      [{ name: 'FOO.esp', enabled: true }],
      { files, filesByMod: new Map([['SomeMod', [modFile('Foo.esp'), modFile('foo.esp')]]]), foldersByMod: new Map() },
      [], { kind: 'found', root: '/game', dataFolder: '/game/Data' }, { kind: 'unresolved' },
    );
    const h = makeTree(rows);
    await reconcile(h, [], [
      { name: 'Foo.esp', origin: 'SomeMod', reason: 'differs only in case from foo.esp' },
      { name: 'foo.esp', origin: 'SomeMod', reason: 'differs only in case from Foo.esp' },
    ]);

    const [row] = await h.tree.getChildren();
    expect((await rowItem(h)).description).toBe('failed to read');
    expect((await h.tree.getChildren(row)).map((c) => c.tooltip)).toEqual(['differs only in case from foo.esp']);
  });

  it('never abandons the row: it stays collapsible, but expands to the error node — it will never be indexed', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    expect((await rowItem(h)).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);
    expect(children.map(c => c.contextValue)).toEqual(['error']);
    expect(present(children[0], 'the error row').tooltip).toBe('Malformed record');
  });

  it('flags a row the moment a load tick reports its plugin failed, before the load completes', async () => {
    const h = makeTree([A_ROW()]);

    h.tree.facts.indexed([], [{ name: 'A.esp', origin: 'SomeMod', reason: 'RACE parse' }]);

    const item = await rowItem(h);
    expect(item.description).toBe('failed to read');
    expect(item.tooltip).toContain('RACE parse');
  });

  it('keeps the failed-to-read status (no blink) while expansion still reads "still indexing" for an unreached plugin', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);
    expect((await rowItem(h)).description).toBe('failed to read');

    h.tree.facts.indexed([], []);

    expect((await rowItem(h)).description).toBe('failed to read');
    const [row] = await h.tree.getChildren();
    expect(rendered(await h.tree.getChildren(row))).toEqual(STILL_INDEXING);
  });

  it('leaves an unaffected plugin row undecorated', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('B.esp')], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    const item = await rowItem(h, 1);
    expect(item.tooltip).toBe('B.esp\nSomeMod');
    expect(item.iconPath).toEqual(new ThemeIcon('blank'));
  });
});

describe('PluginsTreeProvider — malformed-plugin diagnosis decoration', () => {
  const REGN = 'REGN 00ABCDEF (InventedRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8';

  it('decorates a plugin whose only status is malformed with the warning icon, the word malformed and the diagnosis text', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', REGN)]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsWarningIcon.foreground'));
    expect(item.description).toBe('malformed');
    expect(item.tooltip).toContain('RDAT is 6 bytes');
  });

  it('keeps the last diagnoses through a reconcile until its own scan lands', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).description).toBe('malformed');

    let resolveScan!: (reports: PluginDiagnosisReport[]) => void;
    const slow = new Promise<PluginDiagnosisReport[]>((resolve) => { resolveScan = resolve; });
    h.client.setQueryAnswerOnce('getDiagnoses', slow);

    await h.tree.facts.reconciled([]);
    expect((await rowItem(h)).description).toBe('malformed');

    resolveScan([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await rowItem(h)).description).toBeUndefined();
  });

  it('keeps the last diagnoses if the next scan fails', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).description).toBe('malformed');

    h.client.setQueryFailure('getDiagnoses', new Error('mEdit could not answer.'));
    await reconcile(h, [held('A.esp')]);

    expect((await rowItem(h)).description).toBe('malformed');
  });

  it('publishes the scan for the Problems panel as well as the row badge', async () => {
    const published: PluginDiagnosisReport[][] = [];
    const h = makeTree([A_ROW()], { publishDiagnoses: (reports) => published.push(reports) });
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);

    await reconcile(h, [held('A.esp')]);

    expect(published).toEqual([[diagnosis('A.esp', 'some diagnosis')]]);
  });
});

describe('PluginsTreeProvider — changed outside Modbench', () => {
  function settled(h: Harness, origin: string, ...changed: string[]): void {
    h.client.emit({
      kind: 'external-change', plugin: '', origin, keys: [], sequence: 0,
      changedPlugins: changed.map((name) => ({ name, bytesSha256: 'ab12' })),
    });
  }

  it('shows the status on a plugin its mod\'s settle names, at warning tier', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp')]);

    settled(h, 'SomeMod', 'A.esp');

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsWarningIcon.foreground'));
    expect(item.description).toBe('changed outside Modbench');
    expect(tooltipAsString(item.tooltip)).toContain('Changed outside Modbench');
    expect((await rowItem(h, 1)).description).toBeUndefined();
  });

  it('publishes a warning on every plugin that changed outside Modbench for the Problems panel, each mod\'s settle replacing its own', () => {
    const published: string[][] = [];
    const h = makeTree([A_ROW()], {
      publishChangedOutside: (warnings) => published.push(warnings.map((w) => `${w.origin}/${w.plugin}: ${w.text}`)),
    });

    settled(h, 'SomeMod', 'A.esp');
    settled(h, 'OtherMod', 'C.esp');
    settled(h, 'SomeMod');

    const said = ': Changed outside Modbench: its bytes differ from what Modbench last wrote.';
    expect(published).toEqual([
      [`SomeMod/A.esp${said}`],
      [`SomeMod/A.esp${said}`, `OtherMod/C.esp${said}`],
      [`OtherMod/C.esp${said}`],
    ]);
  });
});

describe('PluginsTreeProvider — a healthy plugin row after a reconcile', () => {
  it('states only its kind and where track and compile apply, with no description and the base tooltip', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp')]);

    const items = [await rowItem(h, 0), await rowItem(h, 1)];

    expect(items.map((i) => [i.contextValue, i.description, i.tooltip])).toEqual([
      ['plugin enabled inUntrackedMod untracked editable', undefined, 'A.esp\nSomeMod'],
      ['plugin enabled inUntrackedMod untracked editable', undefined, 'B.esp\nSomeMod'],
    ]);
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
      held('Shared.esp', { origin: 'ModA', masterIssues: ['AMaster.esm'] }),
      held('Shared.esp', { origin: 'ModB', masterIssues: ['BMaster.esm'] }),
    ]);

    const tooltip = tooltipAsString((await rowItem(h)).tooltip);
    expect(tooltip).toContain('Missing masters: AMaster.esm');
    expect(tooltip).not.toContain('BMaster.esm');
  });

  it('reads read-only from its own plugin, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', isImmutable: false }),
      held('Shared.esp', { origin: 'ModB', isImmutable: true }),
    ]);

    expect((await rowItem(h)).tooltip).toBe('Shared.esp\nModA');
  });

  it('reads the parse failure from its own plugin, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', hasParseFailure: false }),
      held('Shared.esp', { origin: 'ModB', hasParseFailure: true }),
    ]);

    expect((await rowItem(h)).iconPath).toEqual(new ThemeIcon('blank'));
  });

  it('reads the record filter answer from its own plugin, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', hasMatchingRecords: true }),
      held('Shared.esp', { origin: 'ModB', hasMatchingRecords: false }),
    ]);

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  it('reads the diagnoses from its own plugin, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('Shared.esp', 'ModB is malformed', 'ModB')]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA' }),
      held('Shared.esp', { origin: 'ModB' }),
    ]);

    expect((await rowItem(h)).description).toBeUndefined();
  });

  it('leaves the winning row clean when the other plugin is the one that failed to read', async () => {
    const h = makeTree([SHARED_ROW(), plugin({ name: 'Shared.esp', line: 0, origin: 'ModB', winning: false })]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModA' })],
      [{ name: 'Shared.esp', origin: 'ModB', reason: 'Malformed record' }]);

    const rows = await h.tree.getChildren();
    expect(rows).toHaveLength(1);
    const item = h.tree.getTreeItem(present(rows[0], 'the sole row'));
    expect(item.iconPath).toEqual(new ThemeIcon('blank'));
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('Shared.esp\nModA');
  });

  it('expands the row as still indexing while only the other plugin has landed', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.tree.facts.indexed([{ name: 'Shared.esp', origin: 'ModB' }], []);

    const [row] = await h.tree.getChildren();
    expect(rendered(await h.tree.getChildren(row))).toEqual(STILL_INDEXING);
  });

  it('expands the row as still indexing while mEdit holds only the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModB' })]);

    const [row] = await h.tree.getChildren();
    expect(rendered(await h.tree.getChildren(row))).toEqual(STILL_INDEXING);
  });

  it('expands the winning row as still indexing, never into the other plugin failure', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.tree.facts.indexed([], [{ name: 'Shared.esp', origin: 'ModB', reason: 'Malformed record' }]);

    const [row] = await h.tree.getChildren();
    expect(rendered(await h.tree.getChildren(row))).toEqual(STILL_INDEXING);
  });

  it('flags the row when its own plugin failed to read and the other plugin loaded', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModB' })],
      [{ name: 'Shared.esp', origin: 'ModA', reason: 'Malformed record' }]);

    expect((await rowItem(h)).description).toBe('failed to read');
  });

  it('states nothing of another plugin of the name when the row origin matches no plugin the answer names', async () => {
    const h = makeTree([plugin({ name: 'A.esp', line: 0, origin: 'RenamedMod' })]);
    await reconcile(h, [held('A.esp', {
      origin: 'SomeOtherMod', isImmutable: true, masterIssues: ['Ghost.esm'],
    })]);

    expect((await rowItem(h)).tooltip).toBe('A.esp\nRenamedMod');
  });
});

describe('PluginsTreeProvider — the facts are pulled once and held', () => {
  it('reads the plugin list once per reconcile, not once per rendered row', async () => {
    const h = makeTree([A_ROW(), B_ROW(), plugin({ name: 'C.esp', line: 2 })]);
    await reconcile(h, [held('A.esp'), held('B.esp'), held('C.esp')]);
    expect(callCount(h.client, 'getPlugins')).toBe(1);

    const rows = await h.tree.getChildren();
    for (const row of rows) h.tree.getTreeItem(row);

    expect(rows).toHaveLength(3);
    expect(callCount(h.client, 'getPlugins')).toBe(1);
  });

  it('reads the malformed-plugin scan once per reconcile, not once per rendered row', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp')]);
    expect(callCount(h.client, 'getDiagnoses')).toBe(1);

    for (const row of await h.tree.getChildren()) h.tree.getTreeItem(row);

    expect(callCount(h.client, 'getDiagnoses')).toBe(1);
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

  it('reads once more per fact refresh, and no more than once', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    await h.tree.facts.refresh();

    expect(callCount(h.client, 'getPlugins')).toBe(2);
  });

  it('reports a failed plugin read at error, naming the reason once', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryFailure('getPlugins', new Error('No load order has been received.'));

    await h.tree.facts.reconciled([]);

    const failures = h.logged.filter((l) => l.msg.includes('plugin list failed'));
    expect(failures).toHaveLength(1);
    expect(present(failures[0], 'the sole logged failure').level).toBe('error');
    expect(present(failures[0], 'the sole logged failure').msg).toContain('No load order has been received.');
  });

  it('reports a failed malformed-plugin scan at warn, below the read that succeeded', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryFailure('getDiagnoses', new Error('mEdit could not answer.'));

    await reconcile(h, [held('A.esp')]);

    const scan = h.logged.filter((l) => l.msg.includes('malformed-plugin scan'));
    expect(scan).toHaveLength(1);
    expect(present(scan[0], 'the sole scan-failure log entry').level).toBe('warn');
    expect(h.logged.some((l) => l.level === 'error')).toBe(false);
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
