import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reorderOver, type PluginsDrop } from '../../pluginsCommands/plugins';
import type { LoadOrderPlugin, LoadOrderPluginLine, PluginAddress } from '../../instanceLoader/loadOrderSnapshot';
import type { InstanceValue } from '../../instanceLoader/instance';
import {
  InMemoryMEditClient, type PluginDiagnosisReport, type PluginLoadFailure, type PluginMetadata, type RecordPage,
  type WorldspaceSummary, type WorldspaceBlocks, type InteriorCellBlock, type RecordSummary, type CellChildRecords,
  type ContainerChildSummary, type CellSummary, type ChildRecordSummary,
} from '../../client';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return {
    ...fakeVscodeModule(),
    TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
    Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
    window: { withProgress: recordedWithProgress },
  };
});

import * as vscode from 'vscode';
import {
  PluginsTreeProvider, PluginNode, ImplicitMasterNode, NO_PLUGINS_MESSAGE, pluginFileOf, isDropPayload,
  type PluginListSource, type PluginsTreeNode, type PluginsTreeProviderOptions,
} from '../PluginsTreeProvider';
import {
  PluginTreeProvider, RecordTypeNode, RecordNode, WorldspacesNode, WorldspaceNode, BlockNode,
  SubBlockNode, CellNode, InteriorCellsNode, InteriorBlockNode, InteriorSubBlockNode, IndexingNode,
} from '../PluginTreeProvider';
import { ErrorNode } from '../../drivingLib/errorNode';
import { recordingReporter } from '../../test/surfacingDoubles';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { progressSteps } from '../../test/recordedProgress';
import { accessTo, readPluginLines } from '../../test/mo2/adapterOver';
import { present } from '../../ports/present';
import { listsForThePluginAsked, recordTypeCountFixture } from '../../client/test/fixtures';

function plugin(
  overrides: Partial<Omit<LoadOrderPlugin, 'path'>> & { name: string; path?: string },
): LoadOrderPlugin | LoadOrderPluginLine {
  return {
    path: `/fixture/${overrides.name}`,
    origin: 'SomeMod',
    slot: 0,
    enabled: true,
    winning: true,
    ...overrides,
  };
}

function valueOf(
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[], pluginsLoadedWithNoLine?: readonly (string | PluginAddress)[],
): InstanceValue {
  const mods = [...new Set(plugins.map((p) => p.origin))].filter((origin) => origin !== 'Data' && origin !== 'overwrite');
  return instanceValueFixture({
    gameFolder: { kind: 'found', root: '/game', dataFolder: '/game/Data' },
    pluginsLoadedWithNoLine: pluginsLoadedWithNoLine?.map((p) => (typeof p === 'string' ? { name: p, origin: 'Data' } : p)),
    plugins, paths: { overwriteDir: '/instance/overwrite', downloadsDir: '', modDirs: new Map(mods.map((m) => [m, `/instance/mods/${m}`])) },
  });
}

const failIfNotSettledWithin = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
  pending,
  new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`getChildren() did not settle within ${ms} ms`)), ms)),
]);

class FakeSource implements PluginListSource {
  reorderPluginsCalls: { names: string[]; drop: PluginsDrop }[] = [];
  reorderPluginsError?: Error;
  reorderPlugins(names: string[], drop: PluginsDrop): Promise<void> {
    if (this.reorderPluginsError) return Promise.reject(this.reorderPluginsError);
    this.reorderPluginsCalls.push({ names, drop });
    return Promise.resolve();
  }
}

const writesTo = (instanceRoot: string): PluginListSource => ({
  reorderPlugins: reorderOver(accessTo(instanceRoot), () => 'Default'),
});

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
    isCreatable: rt.isCreatable ?? true,
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
  records: PluginTreeProvider;
  instance: FakeInstance;
  source: FakeSource;
  logged: { level: string; msg: string }[];
}

function makeTree(
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
  extra: Partial<{
    source: FakeSource;
    instance: FakeInstance;
    client: InMemoryMEditClient;
    publishDiagnoses: (reports: PluginDiagnosisReport[]) => void;
    publishChangedOutside: PluginsTreeProviderOptions['publishChangedOutside'];
    dataFolderFile: (name: string) => string | undefined;
    loadedWithNoLine: readonly (string | PluginAddress)[];
    reporter: PluginsTreeProviderOptions['reporter'];
  }> = {},
): Harness {
  const instance = extra.instance ?? new FakeInstance(valueOf(plugins, extra.loadedWithNoLine));
  const source = extra.source ?? new FakeSource();
  const client = extra.client ?? makeClient();
  const records = new PluginTreeProvider(client);
  const logged: { level: string; msg: string }[] = [];
  const tree = new PluginsTreeProvider({
    instance, source, client, records,
    log: (level, msg) => logged.push({ level, msg }),
    publishDiagnoses: extra.publishDiagnoses,
    publishChangedOutside: extra.publishChangedOutside,
    dataFolderFile: extra.dataFolderFile,
    reporter: extra.reporter,
  });
  return { tree, client, records, instance, source, logged };
}

async function reconcile(
  h: Harness, plugins: PluginMetadata[], failures: PluginLoadFailure[] = [],
): Promise<void> {
  h.client.setQueryAnswer('getPlugins', plugins);
  await h.tree.applyReconciled(failures);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function callCount(client: InMemoryMEditClient, method: string): number {
  return client.calls.filter((c) => c.method === method).length;
}

describe('ImplicitMasterNode — leading slot', () => {
  it('renders a lock icon, not a checkbox, as VS Code has no non-interactive checkbox variant', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data');
    expect(node.iconPath).toEqual({ id: 'lock' });
    expect(node.checkboxState).toBeUndefined();
  });

  it('tooltip is MO2\'s one sentence alone, with no file name', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data');
    expect(node.tooltip).toBe("This plugin can't be disabled or moved (enforced by the game).");
  });

  it('keys resourceUri on the given path, for the label-graying decoration provider', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data', '/game/Data/Fallout4.esm');
    expect(node.resourceUri?.path).toBe('/game/Data/Fallout4.esm');
  });

  it('leaves resourceUri undefined when no path is given (test-construction convenience)', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data');
    expect(node.resourceUri).toBeUndefined();
  });
});

describe('PluginNode / ImplicitMasterNode — row click opens the plugin header', () => {
  it('PluginNode opens the header at the plugin and origin its row stands for', () => {
    const node = new PluginNode({ name: 'TestMod.esp', enabled: true }, 'SomeMod');
    expect(node.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: '000000:TestMod.esp', origin: 'SomeMod' }],
    });
  });

  it('ImplicitMasterNode opens the header at the plugin and origin its row stands for', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', 'Data');
    expect(node.command).toEqual({
      command: 'modbench.record.open', title: 'Open Record', arguments: [{ formKey: '000000:Fallout4.esm', origin: 'Data' }],
    });
  });

  it('two plugins of one file name from different origins open at different addresses', () => {
    const a = new PluginNode({ name: 'Same.esp', enabled: true }, 'ModA');
    const b = new PluginNode({ name: 'Same.esp', enabled: true }, 'ModB');
    expect(a.command?.arguments).not.toEqual(b.command?.arguments);
  });
});

describe('leading slot — rows outside the load order render neither checkbox nor lock', () => {
  it('ErrorNode has no checkbox and no lock', () => {
    const node = new ErrorNode('boom');
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });

  it('IndexingNode has no checkbox and no lock', () => {
    const node = new IndexingNode();
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });
});

describe('PluginNode', () => {
  it('renders a plain row — no icon, no description', () => {
    const node = new PluginNode({ name: 'A.esp', enabled: true }, 'SomeMod');
    expect(node.iconPath).toBeUndefined();
    expect(node.description).toBeUndefined();
  });

  it('carries the origin of the plugin the row stands for (ADR-0012)', () => {
    expect(new PluginNode({ name: 'A.esp', enabled: true }, 'WinnerMod').origin).toBe('WinnerMod');
  });
});

describe('PluginsTreeProvider — rows come from the Instance value', () => {
  it('builds one row per plugins.txt line, in Plugin load order, with the enabled checkbox', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', slot: 0, enabled: false }),
      plugin({ name: 'B.esp', slot: 1, enabled: true }),
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

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    await tree.getChildren();

    expect(tree.viewMessage()).toBeUndefined();
  });

  it('says it shows the last good read, with the reason, when a later read fails, and not once a read lands', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    instance.fail('EACCES plugins.txt');

    expect(tree.viewMessage()).toBe('Showing the last good read: EACCES plugins.txt');
    expect(fired).toHaveLength(1);
    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    expect(tree.viewMessage()).toBeUndefined();
  });

  it('rows exactly match the fixture value, in file order — not a re-derivation', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Zed.esp', slot: 0, enabled: true }),
      plugin({ name: 'Aardvark.esp', slot: 1, enabled: false }),
    ]);
    const rows = await tree.getChildren();
    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Zed.esp', 'Aardvark.esp']);
  });

  it('carries each row\'s own origin from the Instance value', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', slot: 0, origin: 'ModA' }),
      plugin({ name: 'B.esp', slot: 1, origin: 'overwrite' }),
    ]);
    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);
    expect(rows.map((r) => r.origin)).toEqual(['ModA', 'overwrite']);
  });

  it('an overridden plugin of a listed name renders no row of its own', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0, origin: 'Winner', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', winning: false }),
    ]);
    const rows = (await tree.getChildren()).filter((n) => n instanceof PluginNode);
    expect(rows).toHaveLength(1);
  });

  it('an unlisted plugin (slot: null) gets no row', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0 }),
      plugin({ name: 'Unlisted.esp', slot: null, winning: true }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Base.esp']);
  });

  it('still renders a row for a listed name no mod provides, when the Data folder is unresolved', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: '/unresolved/Fallout4.esm' }),
      plugin({ name: 'Mod.esp', slot: 1, origin: 'SomeMod' }),
    ], { dataFolderFile: () => undefined });

    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm', 'Mod.esp']);
  });

  it('renders a row for a LoadOrderPluginLine (path: undefined), with no badge', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: undefined }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm']);
    expect(present(rows[0], 'the LoadOrderPluginLine row').iconPath).toBeUndefined();
  });

  it('resolvePluginPath returns undefined for a LoadOrderPluginLine, never "undefined" as text', async () => {
    const { tree } = makeTree([plugin({ name: 'Fallout4.esm', slot: 0, path: undefined })]);
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'Fallout4.esm', enabled: true }, 'SomeMod'))).toBeUndefined();
  });

  it('re-renders on a new value published after construction', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const { tree } = makeTree([], { instance });
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);

    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]));

    expect(fired).toBe(true);
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('invalidate() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const { tree } = makeTree([plugin({ name: 'A.esp', slot: 0 })]);
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    tree.invalidate();
    expect(fired).toBe(true);
  });

  it('invalidate() clears the cache and re-pulls the current instance value even when nothing was published', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const { tree } = makeTree([], { instance });
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);

    instance.value = valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]);

    tree.invalidate();

    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('renders no rows before the first read, and the read\'s rows once it lands', async () => {
    await withUnreadCorpusInstance(async (instance) => {
      const tree = new PluginsTreeProvider({ instance, source: new FakeSource() });

      const pending = tree.getChildren();
      await instance.refresh();
      const rendered = await pending;

      expect(rendered.length).toBeGreaterThan(0);
      expectInstancesOf(rendered, PluginNode);
      expect(rendered.map((r) => r.label)).toEqual((await tree.getChildren()).map((r) => r.label));
      tree.dispose();
    });
  });

  it('settles a failed first read on the one error row naming the reason, raises nothing, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const reporter = recordingReporter();
    const { tree } = makeTree([], { instance, reporter });

    const pending = tree.getChildren();
    instance.fail('EISDIR: illegal operation on a directory, read plugins.txt');
    const rows = await failIfNotSettledWithin(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.tooltip).toBe('EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));
    expect(reporter.reports).toEqual([]);

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const after = await failIfNotSettledWithin(tree.getChildren(), 500);

    expect(after.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);
    expect(reporter.reports).toEqual([]);
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
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    const [a, b] = await idsOf(tree);

    instance.publish(valueOf([plugin({ name: 'B.esp', slot: 0 }), plugin({ name: 'A.esp', slot: 1 })]));

    expect(await idsOf(tree)).toEqual([b, a]);
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('gives the plugin of the same name from another origin another identity', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0, origin: 'ModA' })]));
    const { tree } = makeTree([], { instance });
    const [fromModA] = await idsOf(tree);

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0, origin: 'ModB' })]));

    const [fromModB] = await idsOf(tree);
    expect(fromModB).toBeDefined();
    expect(fromModB).not.toBe(fromModA);
  });

  it('gives a locked row an identity of its own kind, never a plugin row\'s', async () => {
    const withLine = makeTree([plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data' })]).tree;
    const locked = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] }).tree;

    const [lineId] = await idsOf(withLine);
    const [lockedId] = await idsOf(locked);

    expect(lockedId).toBeDefined();
    expect(lockedId).not.toBe(lineId);
  });

  it('renders a plugin plugins.txt names twice as one row, at its first line', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 }), plugin({ name: 'a.ESP', slot: 2 }),
    ]);

    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);

    expect(rows.map((r) => r.plugin.name)).toEqual(['A.esp', 'B.esp']);
  });
});

describe('PluginsTreeProvider — name filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Alpha.esp', slot: 0 }),
      plugin({ name: 'Beta.esp', slot: 1 }),
      plugin({ name: 'AlphaExtra.esp', slot: 2 }),
    ]);
    tree.setFilter('ALPHA');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('restores the full list when the filter is cleared', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]);
    tree.setFilter('alpha');
    expect(await tree.getChildren()).toHaveLength(1);

    tree.setFilter('');
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('returns an empty list, and no empty-list message, when the filter matches nothing', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]);
    tree.setFilter('nomatch');
    const rows = await tree.getChildren();

    expect(rows).toEqual([]);
    expect(tree.viewMessage()).toBeUndefined();
  });

  it('survives an invalidate() and an underlying value change, narrowing whatever it turns up', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    tree.setFilter('alpha');
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp']);

    instance.value = valueOf([
      plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 }), plugin({ name: 'AlphaTwo.esp', slot: 2 }),
    ]);
    tree.invalidate();

    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'AlphaTwo.esp']);
  });

  it('fires onDidChangeTreeData when the filter is set', () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', slot: 0 })]);
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    tree.setFilter('a');
    expect(fired).toBe(true);
  });

  it('does not rebuild rows on a filter keystroke, serving the cached ones (render-only, not invalidate)', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]);
    tree.setFilter('a');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('clearing the filter restores all cached rows, without rebuilding', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();
    tree.setFilter('alpha');
    await tree.getChildren();

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]);
    tree.setFilter('');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });
});

const IGNORED_TOKEN = new FakeCancellationToken();

function pluginsFrom(item: unknown): { name: string; origin: string }[] {
  const { value } = expectInstanceOf(item, DataTransferItem);
  if (!isDropPayload(value)) throw new Error('Expected a plugins payload');
  return value.plugins;
}

describe('PluginsTreeProvider — drag-and-drop reorder', () => {
  const ORDER = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const fixturePlugins = (names: string[] = ORDER) => names.map((name, slot) => plugin({ name, slot }));
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');

  async function drag(source: FakeSource, moved: string[], target: string | undefined, names: string[] = ORDER) {
    const reporter = recordingReporter();
    const instance = Object.assign(new FakeInstance(valueOf(fixturePlugins(names))), { refresh: () => Promise.resolve() });
    const tree = new PluginsTreeProvider({ instance, source, reporter });
    await tree.getChildren();
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });

    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, IGNORED_TOKEN);
    return { reports: reporter.reports, fired };
  }

  it('carries the origin of each dragged row, so two plugins of one filename stay apart', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();

    tree.handleDrag([
      new PluginNode({ name: 'Same.esp', enabled: true }, 'ModOne'),
      new PluginNode({ name: 'Same.esp', enabled: true }, 'ModTwo'),
    ], dt, IGNORED_TOKEN);

    expect(pluginsFrom(dt.get('application/vnd.medit.pluginlist-node')))
      .toEqual([{ name: 'Same.esp', origin: 'ModOne' }, { name: 'Same.esp', origin: 'ModTwo' }]);
  });

  it('handleDrag serialises the whole selection, not just the grabbed row', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp'), node('C.esp')], dt, IGNORED_TOKEN);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(pluginsFrom(item)).toEqual([{ name: 'A.esp', origin: 'SomeMod' }, { name: 'C.esp', origin: 'SomeMod' }]);
  });

  it('a drop onto a row asks for the block to land before that row', async () => {
    const source = new FakeSource();
    await drag(source, ['A.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('a drop fires nothing before the read lands', async () => {
    const { fired } = await drag(new FakeSource(), ['A.esp'], 'D.esp');
    expect(fired).toBe(false);
  });

  it('drop past the last row (undefined target) asks for the winning end', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp'], undefined);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], drop: { kind: 'winningEnd' } }]);
  });

  it('a drop on a locked row asks for the losing end', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source, loadedWithNoLine: ['Fallout4.esm'] });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('B.esp')], dt, IGNORED_TOKEN);
    await tree.handleDrop(new ImplicitMasterNode('Fallout4.esm', 'Data'), dt, IGNORED_TOKEN);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], drop: { kind: 'losingEnd' } }]);
  });

  it('pluginFileOf names the file a row stands for', () => {
    expect(pluginFileOf(node('A.esp'))).toBe('A.esp');
    expect(pluginFileOf(new ImplicitMasterNode('Fallout4.esm', 'Data'))).toBe('Fallout4.esm');
  });

  it('drop onto a row this tree does not own is refused, not treated as the end of the list', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);

    await tree.handleDrop(new RecordNode(recordSummary(), 'SomeMod'), dt, IGNORED_TOKEN);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('drop onto one of this tree own record rows is refused too', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);

    await tree.handleDrop(new RecordTypeNode('A.esp', recordTypeCountFixture({ type: 'weap', count: 5, displayName: 'Weapon' }), 'SomeMod'), dt, IGNORED_TOKEN);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('contiguous multi-selection moves as one block, named in the drag order', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp', 'C.esp', 'D.esp'], 'A.esp');
    expect(source.reorderPluginsCalls)
      .toEqual([{ names: ['B.esp', 'C.esp', 'D.esp'], drop: { kind: 'before', name: 'A.esp' } }]);
  });

  it('a drop on a row being dragged fires nothing and says nothing', async () => {
    const source = new FakeSource();
    const { reports } = await drag(source, ['A.esp', 'C.esp'], 'C.esp');
    expect(source.reorderPluginsCalls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it('non-contiguous multi-selection names every dragged row, in one drop', async () => {
    const source = new FakeSource();
    await drag(source, ['A.esp', 'C.esp', 'E.esp'], 'D.esp');
    expect(source.reorderPluginsCalls)
      .toEqual([{ names: ['A.esp', 'C.esp', 'E.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('an empty drag payload is a no-op (no write)', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source });
    await tree.getChildren();
    await tree.handleDrop(node('A.esp'), new DataTransfer(), IGNORED_TOKEN);
    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const NAMES = ['M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'];

    const baselineSource = new FakeSource();
    await drag(baselineSource, ['M1.esp'], 'M3.esp', NAMES);

    const filteredSource = new FakeSource();
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins(NAMES))), source: filteredSource,
    });
    await tree.getChildren();
    tree.setFilter('m');
    const visible = await tree.getChildren();
    expect(visible.map((n) => expectInstanceOf(n, PluginNode).plugin.name)).toEqual(['M1.esp', 'M2.esp', 'M3.esp']);

    const dt = new DataTransfer();
    tree.handleDrag([node('M1.esp')], dt, IGNORED_TOKEN);
    await tree.handleDrop(node('M3.esp'), dt, IGNORED_TOKEN);

    expect(filteredSource.reorderPluginsCalls).toEqual(baselineSource.reorderPluginsCalls);
  });

  it('refuses a drop on a row the order has since lost, naming it, and moves nothing', async () => {
    const source = new FakeSource();
    const reporter = recordingReporter();
    const instance = new FakeInstance(valueOf(fixturePlugins()));
    const tree = new PluginsTreeProvider({ instance, source, reporter });
    await tree.getChildren();
    instance.publish(valueOf(fixturePlugins(ORDER.filter((name) => name !== 'D.esp'))));
    await tree.getChildren();

    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);
    await tree.handleDrop(node('D.esp'), dt, IGNORED_TOKEN);

    expect(reporter.reports).toEqual([
      { severity: 'error', message: 'Failed to move plugins.', detail: 'Plugin not found in plugins.txt: D.esp' },
    ]);
    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('surfaces a write failure via the reporter, naming why (ADR-0019)', async () => {
    const source = new FakeSource();
    source.reorderPluginsError = new Error('disk full');
    const { reports, fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(reports).toEqual([{ severity: 'error', message: 'Failed to move plugins.', detail: 'disk full' }]);
    expect(fired).toBe(false);
  });
});

describe('PluginsTreeProvider — a drop keeps master and blueprint order', () => {
  const ORDER = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');

  async function dropAfterReconcile(
    moved: string[], target: PluginsTreeNode | undefined, facts: PluginMetadata[] | undefined,
  ) {
    const source = new FakeSource();
    const reporter = recordingReporter();
    const h = makeTree(ORDER.map((name, slot) => plugin({ name, slot })), { source, reporter });
    if (facts !== undefined) await reconcile(h, facts);
    await h.tree.getChildren();
    const dt = new DataTransfer();
    h.tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);
    await h.tree.handleDrop(target, dt, IGNORED_TOKEN);
    return { calls: source.reorderPluginsCalls, reports: reporter.reports };
  }

  const heldAll = (overrides: Record<string, Partial<PluginMetadata>>) =>
    ORDER.map((name) => held(name, overrides[name] ?? {}));

  it('refuses a drop that puts a master below a plugin that depends on it, naming both, and fires no move', async () => {
    const { calls, reports } = await dropAfterReconcile(['A.esp'], node('D.esp'), heldAll({ 'B.esp': { masters: ['A.esp'] } }));
    expect(calls).toEqual([]);
    expect(reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.', detail: '"A.esp" is a master of "B.esp", so it must load before it.',
    }]);
  });

  it('refuses a drop that puts a master below a disabled plugin that depends on it', async () => {
    const { calls } = await dropAfterReconcile(
      ['A.esp'], node('D.esp'), heldAll({ 'B.esp': { masters: ['A.esp'], inLoadOrder: false } }));
    expect(calls).toEqual([]);
  });

  describe('with winning at the top', () => {
    async function dropWinningAtTop(moved: string, target: string) {
      const source = new FakeSource();
      const reporter = recordingReporter();
      const h = makeTree(ORDER.map((name, slot) => plugin({ name, slot })), { source, reporter });
      await reconcile(h, heldAll({ 'B.esp': { masters: ['A.esp'] } }));
      h.tree.setViewDirection('winningAtTop');
      await h.tree.getChildren();
      const dt = new DataTransfer();
      h.tree.handleDrag([node(moved)], dt, IGNORED_TOKEN);
      await h.tree.handleDrop(node(target), dt, IGNORED_TOKEN);
      return { calls: source.reorderPluginsCalls, reports: reporter.reports };
    }

    it('refuses a master dropped above its dependant, which loads it after', async () => {
      const { calls, reports } = await dropWinningAtTop('A.esp', 'B.esp');
      expect(calls).toEqual([]);
      expect(reports.map((r) => r.detail)).toEqual(['"A.esp" is a master of "B.esp", so it must load before it.']);
    });

    it('lets a dependant dropped above its master land, which loads it after', async () => {
      const { calls, reports } = await dropWinningAtTop('B.esp', 'A.esp');
      expect(reports).toEqual([]);
      expect(calls).toEqual([{ names: ['B.esp'], drop: { kind: 'after', name: 'A.esp' } }]);
    });
  });

  it('matches a master named in another case to its plugins.txt line', async () => {
    const { calls, reports } = await dropAfterReconcile(['A.esp'], node('D.esp'), heldAll({ 'B.esp': { masters: ['a.ESP'] } }));
    expect(calls).toEqual([]);
    expect(reports.map((r) => r.detail)).toEqual(['"A.esp" is a master of "B.esp", so it must load before it.']);
  });

  it('refuses a drop that puts a plugin above its master', async () => {
    const { calls, reports } = await dropAfterReconcile(['C.esp'], node('A.esp'), heldAll({ 'C.esp': { masters: ['B.esp'] } }));
    expect(calls).toEqual([]);
    expect(reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.', detail: '"B.esp" is a master of "C.esp", so it must load before it.',
    }]);
  });

  it('refuses a drop that puts a blueprint plugin before one that is not, naming both', async () => {
    const { calls, reports } = await dropAfterReconcile(['E.esp'], node('C.esp'), heldAll({ 'E.esp': { isBlueprint: true } }));
    expect(calls).toEqual([]);
    expect(reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.',
      detail: '"E.esp" is a blueprint plugin, so it must load after "C.esp", which is not.',
    }]);
  });

  it('refuses a drop that puts a plugin that is not a blueprint after one that is', async () => {
    const { calls, reports } = await dropAfterReconcile(['C.esp'], undefined, heldAll({ 'E.esp': { isBlueprint: true } }));
    expect(calls).toEqual([]);
    expect(reports).toEqual([{
      severity: 'error', message: 'Could not move plugins.',
      detail: '"E.esp" is a blueprint plugin, so it must load after "C.esp", which is not.',
    }]);
  });

  it('fires the move when it keeps every master above its dependants and every blueprint plugin last', async () => {
    const { calls, reports } = await dropAfterReconcile(
      ['C.esp'], node('B.esp'), heldAll({ 'D.esp': { masters: ['A.esp', 'C.esp'] }, 'E.esp': { isBlueprint: true } }));
    expect(calls).toEqual([{ names: ['C.esp'], drop: { kind: 'before', name: 'B.esp' } }]);
    expect(reports).toEqual([]);
  });

  it('fires the move while mEdit has not said which masters any plugin has', async () => {
    const { calls } = await dropAfterReconcile(['A.esp'], node('D.esp'), undefined);
    expect(calls).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('fires the move when mEdit cannot say which masters the dependant has', async () => {
    const { calls } = await dropAfterReconcile(['A.esp'], node('D.esp'), ORDER.filter((n) => n !== 'B.esp').map((n) => held(n)));
    expect(calls).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('does not blame a drop for an order it leaves as it found it', async () => {
    const { calls } = await dropAfterReconcile(['D.esp'], node('C.esp'), heldAll({ 'A.esp': { masters: ['B.esp'] } }));
    expect(calls).toEqual([{ names: ['D.esp'], drop: { kind: 'before', name: 'C.esp' } }]);
  });

  it('fires a drop that puts a plugin that is not a blueprint before its blueprint master, as MO2\'s setPluginPriority keeps master order only between two blueprints or two non-blueprints', async () => {
    const { calls, reports } = await dropAfterReconcile(
      ['D.esp'], node('B.esp'), heldAll({ 'B.esp': { isBlueprint: true }, 'D.esp': { masters: ['B.esp'] } }));
    expect(calls).toEqual([{ names: ['D.esp'], drop: { kind: 'before', name: 'B.esp' } }]);
    expect(reports).toEqual([]);
  });

  it('fires the move when mEdit holds the dependant\'s name only from another origin', async () => {
    const { calls } = await dropAfterReconcile(
      ['A.esp'], node('D.esp'), heldAll({ 'B.esp': { origin: 'OtherMod', masters: ['A.esp'] } }));
    expect(calls).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
  });

  it('fires a drop on a locked row for a plugin whose master is a locked plugin with a line of its own, that line not placing the master', async () => {
    const source = new FakeSource();
    const reporter = recordingReporter();
    const h = makeTree([
      plugin({ name: 'DLCRobot.esm', slot: 0, origin: 'Data' }),
      plugin({ name: 'A.esp', slot: 1 }),
      plugin({ name: 'X.esp', slot: 2 }),
    ], { source, reporter, loadedWithNoLine: ['Fallout4.esm', 'DLCRobot.esm'] });
    await reconcile(h, [
      held('DLCRobot.esm', { origin: 'Data' }), held('A.esp'), held('X.esp', { masters: ['Fallout4.esm', 'DLCRobot.esm'] }),
    ]);
    await h.tree.getChildren();
    const dt = new DataTransfer();
    h.tree.handleDrag([node('X.esp')], dt, IGNORED_TOKEN);

    await h.tree.handleDrop(new ImplicitMasterNode('Fallout4.esm', 'Data'), dt, IGNORED_TOKEN);

    expect(source.reorderPluginsCalls).toEqual([{ names: ['X.esp'], drop: { kind: 'losingEnd' } }]);
    expect(reporter.reports).toEqual([]);
  });

  it('refuses a drop that puts a blueprint master below a blueprint plugin that depends on it', async () => {
    const { calls, reports } = await dropAfterReconcile(
      ['D.esp'], undefined, heldAll({ 'D.esp': { isBlueprint: true }, 'E.esp': { isBlueprint: true, masters: ['D.esp'] } }));
    expect(calls).toEqual([]);
    expect(reports.map((r) => r.detail)).toEqual(['"D.esp" is a master of "E.esp", so it must load before it.']);
  });
});

describe('PluginsTreeProvider — drag reorder round-trips through plugins.txt on disk', () => {
  let dir: string;
  let source: PluginListSource;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const orderOnDisk = async () => (await readPluginLines(dir)).map((e) => e.name);
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');
  const fixturePlugins = () => ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'].map((name, slot) => plugin({ name, slot }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-dnd-'));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n');
    await writeFile(pluginsTxt(), '# header\r\n*A.esp\r\nB.esp\r\n*C.esp\r\nD.esp\r\nE.esp\r\n');
    source = writesTo(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dragToDisk(moved: string[], target: string | undefined) {
    const tree = new PluginsTreeProvider({ instance: new FakeInstance(valueOf(fixturePlugins())), source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, IGNORED_TOKEN);
  }

  it('single-row down-drag lands the row before the target, keeping the comment header and every line\'s enabled mark byte for byte', async () => {
    await dragToDisk(['A.esp'], 'D.esp');
    expect(await readFile(pluginsTxt(), 'utf8')).toBe('# header\r\nB.esp\r\n*C.esp\r\n*A.esp\r\nD.esp\r\nE.esp\r\n');
  });

  it('non-contiguous multi-selection moves as a block, preserving relative order', async () => {
    await dragToDisk(['A.esp', 'C.esp', 'E.esp'], 'D.esp');
    expect(await orderOnDisk()).toEqual(['B.esp', 'A.esp', 'C.esp', 'E.esp', 'D.esp']);
  });

  it('drop past the last row appends the moved row', async () => {
    await dragToDisk(['B.esp'], undefined);
    expect(await orderOnDisk()).toEqual(['A.esp', 'C.esp', 'D.esp', 'E.esp', 'B.esp']);
  });

  it('a drop on a locked row lands the block first in plugins.txt, its losing end', async () => {
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins(), ['Fallout4.esm'])), source,
    });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('D.esp')], dt, IGNORED_TOKEN);

    await tree.handleDrop(new ImplicitMasterNode('Fallout4.esm', 'Data'), dt, IGNORED_TOKEN);

    expect(await orderOnDisk()).toEqual(['D.esp', 'A.esp', 'B.esp', 'C.esp', 'E.esp']);
  });

  it('a drag-reorder still writes plugins.txt with the client reporting disconnected', async () => {
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins())), source, client: makeDisconnectedClient(),
    });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, IGNORED_TOKEN);

    await tree.handleDrop(node('D.esp'), dt, IGNORED_TOKEN);

    expect(await readFile(pluginsTxt(), 'utf8')).toBe('# header\r\nB.esp\r\n*C.esp\r\n*A.esp\r\nD.esp\r\nE.esp\r\n');
  });
});

describe('PluginsTreeProvider — isEnabled', () => {
  it('answers from the Instance value, matching the row\'s file name and origin without case', () => {
    const { tree } = makeTree([
      plugin({ name: 'Mod.esp', slot: 0, origin: 'ModA', enabled: true }),
      plugin({ name: 'Off.esp', slot: 1, origin: 'ModA', enabled: false }),
    ]);

    expect(tree.isEnabled(new PluginNode({ name: 'mod.ESP', enabled: false }, 'moda'))).toBe(true);
    expect(tree.isEnabled(new PluginNode({ name: 'Off.esp', enabled: true }, 'ModA'))).toBe(false);
  });

  it('answers false for a row of the same file name at another origin', () => {
    const { tree } = makeTree([plugin({ name: 'Mod.esp', slot: 0, origin: 'ModA', enabled: true })]);

    expect(tree.isEnabled(new PluginNode({ name: 'Mod.esp', enabled: true }, 'ModB'))).toBe(false);
  });
});

describe('PluginsTreeProvider — resolvePluginPath (Reveal in Explorer)', () => {
  const lockedRowOf = async (tree: PluginsTreeProvider) =>
    present((await tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');

  it('resolves a plugin row to its own plugin\'s file, by origin and file name', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0, origin: 'Winner', path: '/data/mods/Winner/Base.esp', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', path: '/data/mods/Loser/Base.esp', winning: false }),
    ]);
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'base.esp', enabled: true }, 'Loser'))).toBe('/data/mods/Loser/Base.esp');
  });

  it('returns undefined when no plugin has the row\'s origin and file name', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Base.esp', slot: 0, origin: 'OtherMod' })], { dataFolderFile: (name) => `/game/Data/${name}` });
    expect(await tree.resolvePluginPath(new PluginNode({ name: 'Base.esp', enabled: true }, 'SomeMod'))).toBeUndefined();
  });

  it('resolves a locked row the game loads from a mod to that mod\'s copy, not the game folder\'s', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Fallout4.esm', slot: 0, origin: 'SomeMod', path: '/instance/mods/SomeMod/Fallout4.esm' })],
      { dataFolderFile: (name) => `/game/Data/${name}`, loadedWithNoLine: [{ name: 'Fallout4.esm', origin: 'SomeMod' }] });
    const locked = await lockedRowOf(tree);

    expect(locked.origin).toBe('SomeMod');
    expect(await tree.resolvePluginPath(locked)).toBe('/instance/mods/SomeMod/Fallout4.esm');
  });

  it('resolves a locked row no mod provides to the game folder\'s copy', async () => {
    const { tree } = makeTree(
      [plugin({ name: 'Mod.esp', slot: 0 })],
      { dataFolderFile: (name) => `/game/Data/${name}`, loadedWithNoLine: ['Fallout4.esm'] });

    expect(await tree.resolvePluginPath(await lockedRowOf(tree))).toBe('/game/Data/Fallout4.esm');
  });

  it('resolves a locked row to nothing while the game folder is not found', async () => {
    const { tree } = makeTree([], { dataFolderFile: () => undefined });
    expect(await tree.resolvePluginPath(new ImplicitMasterNode('Fallout4.esm', 'Data'))).toBeUndefined();
  });
});

describe('PluginsTreeProvider — implicit master rows', () => {
  const ADAPTER_ANSWER = (name: string) => `/adapter/Data/${name}`;
  const ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT = null;
  const treeFor = (
    plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
    implicit: readonly string[] | typeof ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT = [],
    dataFolderFile: ((name: string) => string | undefined) | typeof ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT = ADAPTER_ANSWER,
  ) => makeTree(plugins, {
    dataFolderFile: dataFolderFile ?? (() => undefined),
    ...(implicit === ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT ? {} : { loadedWithNoLine: implicit }),
  }).tree;

  it('renders the backend names as ImplicitMasterNode rows preceding plugins.txt rows, in the order given, not sorted (DLCCoast.esm would sort ahead of Fallout4.esm), with no checkbox and contextValue pluginImplicit', async () => {
    const rows = await treeFor(
      [plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm', 'DLCCoast.esm'],
    ).getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm', 'DLCCoast.esm', 'Mod.esp']);
    expect(rows[0]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[1]).toBeInstanceOf(ImplicitMasterNode);
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).contextValue).toBe('pluginImplicit');
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).checkboxState).toBeUndefined();
    expect(rows[2]).toBeInstanceOf(PluginNode);
  });

  it('takes each implicit row file from the Instance adapter, for the graying decoration to key on', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']).getChildren();
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).resourceUri?.path).toBe('/adapter/Data/Fallout4.esm');
  });

  it('a name the backend calls implicit which plugins.txt also lists renders exactly once, as the implicit row (an .esl the game loads on its own)', async () => {
    const rows = await treeFor([
      plugin({ name: 'Fallout4.esm', slot: 0 }),
      plugin({ name: 'ccBGSFO4044-HellfirePowerArmor.esl', slot: 1 }),
    ], ['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']).getChildren();

    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']);
    expect(rows.every((r) => r instanceof ImplicitMasterNode)).toBe(true);
  });

  it('matches a plugins.txt line to an implicit name case-insensitively', async () => {
    const rows = await treeFor([plugin({ name: 'FALLOUT4.ESM', slot: 0 })], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('publishes each locked row\'s URI, for the graying decoration provider', async () => {
    const tree = treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']);
    const [locked] = await tree.getChildren();
    const rowUri = present(expectInstanceOf(locked, ImplicitMasterNode).resourceUri, 'the locked row\'s URI');
    expect([...tree.lockedRowUris()]).toEqual([rowUri.toString()]);
  });

  it('renders no implicit row, and every plugins.txt line, when the value cannot say', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT).getChildren();

    expect(rows.some((r) => r instanceof ImplicitMasterNode)).toBe(false);
    expect(rows.map((r) => r.label)).toEqual(['Mod.esp']);
    expect([...treeFor([], ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT).lockedRowUris()]).toEqual([]);
  });

  it('renders only implicit rows when plugins.txt is empty, rather than the empty state', async () => {
    const rows = await treeFor([], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('leaves an implicit row without a resourceUri when the Data folder is unresolved', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm'], ABSENT_SINCE_UNDEFINED_SELECTS_THE_DEFAULT).getChildren();
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).resourceUri).toBeUndefined();
  });

  it('handleDrag still filters to only PluginNode rows, excluding implicit rows for free', async () => {
    const tree = treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']);
    const rows = await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(rows, dt, IGNORED_TOKEN);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(pluginsFrom(item).map((p) => p.name)).toEqual(['Mod.esp']);
  });
});

describe('PluginsTreeProvider — the sort direction', () => {
  const LOCKED = ['Fallout4.esm', 'DLCRobot.esm'];
  const LINES = () => [plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 }), plugin({ name: 'C.esp', slot: 2 })];
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
    const { tree } = makeTree([...LINES(), plugin({ name: 'AB.esp', slot: 3 })]);

    tree.setViewDirection('winningAtTop');
    tree.setFilter('a');

    expect(await labelsOf(tree)).toEqual(['AB.esp', 'A.esp']);
  });
});

describe('PluginsTreeProvider — a drop lands where it is shown, in either sort direction', () => {
  let dir: string;
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');
  const LINES = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const LOCKED_ROW = new ImplicitMasterNode('Fallout4.esm', 'Data');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-sorted-drop-'));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n');
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), LINES.map((name) => `${name}\r\n`).join(''));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    { direction: 'losingAtTop', moved: ['E.esp'], where: 'B.esp', target: node('B.esp'), onDisk: ['A.esp', 'E.esp', 'B.esp', 'C.esp', 'D.esp'] },
    { direction: 'losingAtTop', moved: ['A.esp'], where: 'below the last row', target: undefined, onDisk: ['B.esp', 'C.esp', 'D.esp', 'E.esp', 'A.esp'] },
    { direction: 'losingAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED_ROW, onDisk: ['C.esp', 'A.esp', 'B.esp', 'D.esp', 'E.esp'] },
    { direction: 'winningAtTop', moved: ['A.esp'], where: 'D.esp', target: node('D.esp'), onDisk: ['B.esp', 'C.esp', 'D.esp', 'A.esp', 'E.esp'] },
    { direction: 'winningAtTop', moved: ['A.esp', 'B.esp'], where: 'D.esp', target: node('D.esp'), onDisk: ['C.esp', 'D.esp', 'A.esp', 'B.esp', 'E.esp'] },
    { direction: 'winningAtTop', moved: ['E.esp'], where: 'below the last row', target: undefined, onDisk: ['E.esp', 'A.esp', 'B.esp', 'C.esp', 'D.esp'] },
    { direction: 'winningAtTop', moved: ['C.esp'], where: 'the locked Fallout4.esm', target: LOCKED_ROW, onDisk: ['C.esp', 'A.esp', 'B.esp', 'D.esp', 'E.esp'] },
  ] as const)('$direction: $moved dropped on $where lands as shown', async ({ direction, moved, target, onDisk }) => {
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(LINES.map((name, slot) => plugin({ name, slot })), ['Fallout4.esm'])),
      source: writesTo(dir),
    });
    tree.setViewDirection(direction);
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);

    await tree.handleDrop(target, dt, IGNORED_TOKEN);

    expect((await readPluginLines(dir)).map((line) => line.name)).toEqual(onDisk);
  });
});

describe('PluginsTreeProvider — the locked plugins follow the instance value', () => {
  const LINES = () => [plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data' }), plugin({ name: 'Mod.esp', slot: 1 })];
  const shapeOf = async (tree: PluginsTreeProvider) => (await tree.getChildren())
    .map((row) => (row instanceof PluginNode || row instanceof ImplicitMasterNode ? `${row.kind} ${pluginFileOf(row)}` : row.kind));

  it('shows a line naming a locked plugin as an ordinary row while the value cannot say, then locks it at the losing end', async () => {
    const instance = new FakeInstance(valueOf(LINES()));
    const h = makeTree([], { instance });
    expect(await shapeOf(h.tree)).toEqual(['plugin Fallout4.esm', 'plugin Mod.esp']);

    instance.publish(valueOf(LINES(), ['Fallout4.esm', 'DLCRobot.esm']));

    expect(await shapeOf(h.tree)).toEqual(['implicitMaster Fallout4.esm', 'implicitMaster DLCRobot.esm', 'plugin Mod.esp']);
  });
});

describe('PluginsTreeProvider — implicit master drop-index mapping', () => {
  let dir: string;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');
  const fixturePlugins = () => [plugin({ name: 'B.esp', slot: 0 }), plugin({ name: 'C.esp', slot: 1 })];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-implicit-drop-'));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n');
    await writeFile(pluginsTxt(), '*B.esp\r\n*C.esp\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dragToDisk(moved: string[], target: PluginNode | ImplicitMasterNode | undefined) {
    const source = writesTo(dir);
    const tree = new PluginsTreeProvider({ instance: new FakeInstance(valueOf(fixturePlugins())), source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, IGNORED_TOKEN);
    await tree.handleDrop(target, dt, IGNORED_TOKEN);
  }

  it('dropping onto the implicit block lands the moved plugin at file-index 0, and the file never gains an implicit-master line', async () => {
    await dragToDisk(['C.esp'], new ImplicitMasterNode('Fallout4.esm', 'Data'));

    const text = await readFile(pluginsTxt(), 'utf8');
    expect(text).toBe('*C.esp\r\n*B.esp\r\n');
    expect(text).not.toContain('Fallout4.esm');
  });

  it('dropping onto a normal row is unaffected by the implicit prefix — same file index as with no implicit rows at all', async () => {
    await dragToDisk(['C.esp'], node('B.esp'));
    expect(await readFile(pluginsTxt(), 'utf8')).toBe('*C.esp\r\n*B.esp\r\n');
  });
});

const A_ROW = () => plugin({ name: 'A.esp', slot: 0, origin: 'SomeMod' });
const B_ROW = () => plugin({ name: 'B.esp', slot: 1, origin: 'SomeMod' });

function makeDisconnectedClient(): InMemoryMEditClient {
  return disconnect(makeClient());
}

function disconnect(client: InMemoryMEditClient): InMemoryMEditClient {
  client.disconnected();
  return client;
}

describe('PluginsTreeProvider — an enabled row is always collapsible', () => {
  it('gives every plugin row a chevron with no client and no records wired at all', async () => {
    const tree = new PluginsTreeProvider({ instance: new FakeInstance(valueOf([A_ROW(), B_ROW()])), source: new FakeSource() });
    for (const row of await tree.getChildren()) {
      expect(tree.getTreeItem(row).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    }
  });

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

    h.tree.applyIndexed([], []);

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
    const { tree } = makeTree([plugin({ name: 'A.esp', slot: 0, enabled: false })]);
    const [row] = await tree.getChildren();

    expect(tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('stays None once mEdit holds the plugin — enabling is what would give it a chevron, not indexing', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, enabled: false })]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(row, 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('an enabled row beside it still gets a chevron', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', slot: 0, enabled: false }),
      plugin({ name: 'B.esp', slot: 1, enabled: true }),
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

    expect(children).toEqual([expect.any(IndexingNode)]);
    expect(callCount(client, 'getRecordTypes')).toBe(0);
  });

  it('reads no plugin facts before a reconcile', async () => {
    const { tree, client } = makeTree([A_ROW()]);
    const [row] = await tree.getChildren();
    tree.getTreeItem(present(row, 'the sole row'));
    expect(callCount(client, 'getPlugins')).toBe(0);
  });

  it('matches the load order case-insensitively when deciding a row is held', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('a.ESP')]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(client.calls).toContainEqual({ method: 'getRecordTypes', args: ['A.esp', 'SomeMod'] });
    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });

  it('a plugin the load order does not hold yet expands to a "still indexing" node', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const rows = await h.tree.getChildren();

    expect(await h.tree.getChildren(rows[1])).toEqual([expect.any(IndexingNode)]);
  });

  it('applyIndexed lets a landed plugin expand into records, and leaves an un-landed one still indexing, with no plugin facts read', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW(), B_ROW()], { client });
    const rows = await h.tree.getChildren();

    h.tree.applyIndexed([{ name: 'A.esp', origin: 'SomeMod' }], []);

    expect((await h.tree.getChildren(rows[0]))[0]).toBeInstanceOf(RecordTypeNode);
    expect(await h.tree.getChildren(rows[1])).toEqual([expect.any(IndexingNode)]);
    expect(callCount(h.client, 'getPlugins')).toBe(0);
  });

  it('expanding after a load order was held and the client then refuses answers with one error node', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    disconnect(h.client);

    const children = await h.tree.getChildren(row);
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('expanding while a fresh load holds nothing yet answers with one node, never an empty list', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.applyIndexed([], []);

    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
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

    h.tree.applyIndexed([], []);

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
    const h = makeTree([plugin({ name: 'Shared.esp', slot: 0, origin: 'ModB' })], { client });
    await reconcile(h, answer);

    const [row] = await h.tree.getChildren();
    const [group] = await h.tree.getChildren(present(row, 'the Shared.esp row'));
    const [record] = await h.tree.getChildren(present(group, 'the Weapon group'));

    expect(expectInstanceOf(record, RecordNode).contextValue).toBe('record untracked editable');
    expect(expectInstanceOf(group, RecordTypeNode).contextValue).toBe('recordType untracked editable creatable');
  });
});

describe('PluginsTreeProvider — the conditions a record row reads are its plugin row\'s', () => {
  const weaponOf = (record: RecordSummary) => makeClient({
    recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }], records: { items: [record], total: 1 },
  });

  async function firstRecordUnder(h: Harness, row: PluginsTreeNode) {
    const [group] = await h.tree.getChildren(row);
    const [record] = await h.tree.getChildren(present(group, 'the Weapon group'));
    return { group: expectInstanceOf(group, RecordTypeNode), record: expectInstanceOf(record, RecordNode) };
  }

  it('states an override record under a tracked, editable plugin tracked and editable', async () => {
    const client = weaponOf(recordSummary({ formKey: '000001:Fallout4.esm' }));
    const h = makeTree([plugin({ name: 'A.esp', slot: 0 })], { client });
    await reconcile(h, [held('A.esp', { isTracked: true }), held('Fallout4.esm', { origin: 'Data', isImmutable: true })]);

    const [row] = await h.tree.getChildren();
    const { record } = await firstRecordUnder(h, present(row, 'the A.esp row'));

    expect(record.contextValue).toBe('record tracked editable');
  });

  it('flips a record row on the reconcile that tracks its plugin, from the rows already read', async () => {
    const client = weaponOf(recordSummary());
    const h = makeTree([plugin({ name: 'A.esp', slot: 0 })], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();
    expect((await firstRecordUnder(h, present(row, 'the A.esp row'))).record.contextValue).toBe('record untracked editable');
    const reads = client.calls.filter((c) => c.method === 'getRecords').length;

    await reconcile(h, [held('A.esp', { isTracked: true })]);
    const [again] = await h.tree.getChildren();

    expect((await firstRecordUnder(h, present(again, 'the A.esp row'))).record.contextValue).toBe('record tracked editable');
    expect(client.calls.filter((c) => c.method === 'getRecords')).toHaveLength(reads);
  });

  const DATA_COPY = held('Fallout4.esm', { origin: 'Data', isImmutable: true });
  const MOD_COPY = held('Fallout4.esm', { origin: 'ModA', isTracked: true });
  const lockedTree = (modCopyWins: boolean) => makeTree(
    [plugin({ name: 'Fallout4.esm', slot: null, origin: 'ModA', winning: modCopyWins }), plugin({ name: 'A.esp', slot: 0 })],
    { client: weaponOf(recordSummary({ plugin: 'Fallout4.esm', formKey: '000001:Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data' })),
      loadedWithNoLine: [{ name: 'Fallout4.esm', origin: modCopyWins ? 'ModA' : 'Data' }] });

  it.each([['last', [DATA_COPY, MOD_COPY]], ['first', [MOD_COPY, DATA_COPY]]])(
    'states a locked row the game folder provides by the game folder\'s copy, with the mod\'s copy listed %s',
    async (_order, answer) => {
      const h = lockedTree(false);
      await reconcile(h, [...answer, held('A.esp')]);

      const locked = present((await h.tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');
      const { group, record } = await firstRecordUnder(h, locked);

      expect(locked.origin).toBe('Data');
      expect([group.contextValue, record.contextValue]).toEqual(['recordType untracked creatable', 'record untracked']);
    });

  it('expands a locked row mEdit names no plugin for at its origin as still indexing', async () => {
    const h = lockedTree(false);
    await reconcile(h, [MOD_COPY, held('A.esp')]);

    const locked = present((await h.tree.getChildren()).find((n) => n instanceof ImplicitMasterNode), 'the locked row');

    expect(await h.tree.getChildren(locked)).toEqual([expect.any(IndexingNode)]);
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

    expect(await h.tree.applyReconciled([])).toBeUndefined();

    expect(callCount(h.client, 'getPlugins')).toBeGreaterThan(0);
  });

  it('renders the rows, in load order, the same as if it were connected', async () => {
    const h = makeTree([A_ROW(), B_ROW()], { client: makeDisconnectedClient() });
    await h.tree.applyReconciled([]);

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('expanding a row yields exactly one error node', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await h.tree.applyReconciled([]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('names the reason the read failed, not a generic "not connected" message', async () => {
    const client = makeClient();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));
    const h = makeTree([A_ROW()], { client });
    await h.tree.applyReconciled([]);
    const [row] = await h.tree.getChildren();

    const [child] = await h.tree.getChildren(row);

    expect(expectInstanceOf(child, ErrorNode).tooltip).toBe('ECONNREFUSED');
  });

  it('renders no backend-derived badge on any row, only the file name and mod as its tooltip', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await h.tree.applyReconciled([]);
    const [row] = await h.tree.getChildren();

    const item = h.tree.getTreeItem(present(row, 'the sole row'));
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.description).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  it('is distinguishable from a "still indexing" row', async () => {
    const disconnected = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await disconnected.tree.applyReconciled([]);
    const [discRow] = await disconnected.tree.getChildren();
    const [discChild] = await disconnected.tree.getChildren(discRow);

    const indexing = makeTree([A_ROW(), B_ROW()]);
    indexing.tree.applyIndexed([{ name: 'A.esp', origin: 'SomeMod' }], []);
    const rows = await indexing.tree.getChildren();
    const [idxChild] = await indexing.tree.getChildren(rows[1]);

    expect(discChild).toBeInstanceOf(ErrorNode);
    expect(idxChild).toBeInstanceOf(IndexingNode);
    expect(expectInstanceOf(discChild, ErrorNode).label).not.toBe(expectInstanceOf(idxChild, IndexingNode).label);
  });
});

describe("PluginsTreeProvider — the load order's own refusal", () => {
  const heldElsewhere = { kind: 'heldElsewhere' as const, message: 'another Modbench window holds this instance' };
  const failed = { kind: 'failed' as const, message: 'the reconcile threw something unexpected' };

  it('expands a row to the error row naming a heldElsewhere refusal, before any reconcile has landed', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();

    h.tree.applyRefused(heldElsewhere);
    const children = await h.tree.getChildren(row);

    expect(children).toHaveLength(1);
    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe(heldElsewhere.message);
  });

  it("a heldElsewhere refusal overrides an already-held plugin's records too, not only the unindexed rows", async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.applyRefused(heldElsewhere);
    const children = await h.tree.getChildren(row);

    expect(children).toEqual([expect.any(ErrorNode)]);
  });

  it("a failed refusal leaves an already-held plugin's records alone", async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    h.tree.applyRefused(failed);
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });

  it('a failed refusal names the reason on a row this reload never reached', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]);
    const rows = await h.tree.getChildren();

    h.tree.applyRefused(failed);
    const children = await h.tree.getChildren(rows[1]);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe(failed.message);
  });

  it("a failed refusal names the failure on the view's message line until the next reconcile ticks", async () => {
    const h = makeTree([A_ROW()]);
    await h.tree.getChildren();

    h.tree.applyRefused(failed);
    expect(h.tree.viewMessage()).toBe(`Indexing failed: ${failed.message}`);

    h.tree.applyIndexed([], []);
    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('a reconcile that lands with no tick of its own clears a failed refusal from the message line', async () => {
    const h = makeTree([A_ROW()]);
    await h.tree.getChildren();
    h.tree.applyRefused(failed);

    await reconcile(h, [held('A.esp')]);

    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('a heldElsewhere refusal clears an earlier failed refusal from the message line', async () => {
    const h = makeTree([A_ROW()]);
    await h.tree.getChildren();
    h.tree.applyRefused(failed);

    h.tree.applyRefused(heldElsewhere);

    expect(h.tree.viewMessage()).toBeUndefined();
  });

  it('leaves the row set and each row\'s status alone — the tree does not change shape', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp', { masterIssues: ['C.esp'] })]);
    const before = await h.tree.getChildren();
    const statusBefore = h.tree.getTreeItem(present(before[1], "B.esp's row")).description;

    h.tree.applyRefused(heldElsewhere);
    const after = await h.tree.getChildren();

    expect(after).toEqual(before);
    expect(h.tree.getTreeItem(present(after[1], "B.esp's row")).description).toBe(statusBefore);
  });

  it('clears once a later tick lands, resuming normal expansion into records', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    h.tree.applyRefused(heldElsewhere);

    h.tree.applyIndexed([{ name: 'A.esp', origin: 'SomeMod' }], []);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });
});

describe('PluginsTreeProvider — applyBackendUnreachable', () => {
  it('names the reason on a row, before any reconcile has landed', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected.');
    const children = await h.tree.getChildren(row);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('mEdit is disconnected.');
  });

  it('names the reason on a row this reload has not reached yet, mid-reconcile', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    h.tree.applyIndexed([{ name: 'A.esp', origin: 'SomeMod' }], []);
    const rows = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected.');
    const children = await h.tree.getChildren(rows[1]);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('mEdit is disconnected.');
  });

  it('leaves an already-held row browsable — the disconnect is not this row\'s to report', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    h.tree.applyIndexed([{ name: 'A.esp', origin: 'SomeMod' }], []);
    const [row] = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected.');
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });

  it('clears once a later tick lands, resuming "Still indexing…"', async () => {
    const h = makeTree([A_ROW()]);
    h.tree.applyBackendUnreachable('mEdit is disconnected.');

    h.tree.applyIndexed([], []);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(IndexingNode);
  });

  it('never downgrades an everyRow refusal already in force', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();
    h.tree.applyRefused({ kind: 'heldElsewhere', message: 'another Modbench window holds this instance' });

    h.tree.applyBackendUnreachable('mEdit is disconnected.');
    const children = await h.tree.getChildren(row);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('another Modbench window holds this instance');
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
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data', hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  const ownCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'Data', hasMatchingRecords: matches });
  const modCopy = (matches: boolean) => held('Fallout4.esm', { origin: 'ModA', hasMatchingRecords: matches });
  it.each([
    ['hides', 'matches nothing', 'first', [ownCopy(false), modCopy(true)], 0],
    ['hides', 'matches nothing', 'last', [modCopy(true), ownCopy(false)], 0],
    ['shows', 'matches', 'first', [ownCopy(true), modCopy(false)], 1],
    ['shows', 'matches', 'last', [modCopy(false), ownCopy(true)], 1],
  ] as const)('%s a locked row whose own copy %s, with its own copy listed %s', async (_verb, _match, _order, answer, rows) => {
    const h = makeTree(
      [plugin({ name: 'Fallout4.esm', slot: null, origin: 'ModA', winning: false })],
      { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [...answer]);

    expect(await h.tree.getChildren()).toHaveLength(rows);
  });

  it('hides no row by the answer for another plugin of its name, when mEdit names none at its origin', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'RenamedMod' })]);
    await reconcile(h, [held('A.esp', { origin: 'SomeOtherMod', hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  it('restores a hidden plugin immediately, in load order, once the filter clears', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);

    h.client.setQueryAnswer('getPlugins', [held('A.esp'), held('B.esp')]);
    await h.tree.refreshFacts();

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('restores a hidden row in its new position when the underlying order changed while it was hidden', async () => {
    const instance = new FakeInstance(valueOf([A_ROW(), B_ROW()]));
    const h = makeTree([], { instance });
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);

    instance.publish(valueOf([
      plugin({ name: 'B.esp', slot: 0 }), plugin({ name: 'A.esp', slot: 1 }),
    ]));
    h.client.setQueryAnswer('getPlugins', [held('A.esp'), held('B.esp')]);
    await h.tree.refreshFacts();

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

  it('shows every row again when the fact re-read fails', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(await h.tree.getChildren()).toEqual([]);

    h.client.setQueryFailure('getPlugins', new Error('GET /plugins failed (503)'));
    expect(await h.tree.refreshFacts()).toBeUndefined();

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  it('keeps a filter-hidden row hidden while a fresh load is in progress', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(await h.tree.getChildren()).toEqual([]);

    h.tree.applyIndexed([], []);

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

  it('a filter set while the client is answering, then cleared, leaves no stale hidden row', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    expect(await h.tree.getChildren()).toHaveLength(1);

    let resolveSlow!: (plugins: PluginMetadata[]) => void;
    const slow = new Promise<PluginMetadata[]>((resolve) => { resolveSlow = resolve; });
    h.client.setQueryAnswerOnce('getPlugins', slow);
    h.client.setQueryAnswer('getPlugins', [held('A.esp')]);

    const filterSet = h.tree.refreshFacts();
    await h.tree.refreshFacts();
    expect(await h.tree.getChildren()).toHaveLength(1);

    resolveSlow([held('A.esp', { hasMatchingRecords: false })]);
    await filterSet;

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  it('a fact re-read during a reconcile hand-off leaves the hand-off standing', async () => {
    const h = makeTree([A_ROW()]);
    let resolveSlow!: (plugins: PluginMetadata[]) => void;
    h.client.setQueryAnswerOnce('getPlugins', new Promise<PluginMetadata[]>((resolve) => { resolveSlow = resolve; }));
    h.client.setQueryAnswer('getPlugins', [held('A.esp')]);

    const handOff = h.tree.applyReconciled([]);
    await h.tree.refreshFacts();
    resolveSlow([held('A.esp')]);

    expect(await handOff).toEqual([{ name: 'A.esp', hasMatchingRecords: true }]);
    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).not.toContainEqual(expect.any(IndexingNode));
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

    expect(client.calls).toContainEqual({ method: 'getRecordTypes', args: ['A.esp', 'SomeMod'] });
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(RecordTypeNode);
    expect(expectInstanceOf(children[0], RecordTypeNode).label).toBe('Weapon');
    expect(expectInstanceOf(children[0], RecordTypeNode).description).toBe('5');
  });

  it('reads the row\'s own plugin of a shared filename, and every row beneath it carries that plugin', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummary({ plugin: 'Shared.esp', formKey: '000001:Shared.esp', origin: 'ModB' })], total: 1 },
    });
    const h = makeTree([
      plugin({ name: 'Shared.esp', slot: 0, origin: 'ModA', winning: false }),
      plugin({ name: 'Shared.esp', slot: 0, origin: 'ModB' }),
    ], { client });
    await reconcile(h, [held('Shared.esp', { origin: 'ModA' }), held('Shared.esp', { origin: 'ModB' })]);
    const [row] = await h.tree.getChildren();

    const group = expectInstanceOf((await h.tree.getChildren(row))[0], RecordTypeNode);
    const record = expectInstanceOf((await h.tree.getChildren(group))[0], RecordNode);

    expect(client.calls.filter((c) => c.method === 'getRecordTypes' || c.method === 'getRecords').map((c) => c.args))
      .toEqual([['Shared.esp', 'ModB'], ['Shared.esp', 'weap', 0, expect.any(Number), 'ModB']]);
    expect([group.plugin, group.origin, record.record.plugin, record.origin]).toEqual(['Shared.esp', 'ModB', 'Shared.esp', 'ModB']);
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

    expect(records[0]).toBeInstanceOf(RecordNode);
    expect(expectInstanceOf(records[0], RecordNode).label).toBe('TheWeapon');
  });

  it('renders the worldspace and cell hierarchy under a row', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ formKey: 'w:A.esp', editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
      worldspaceBlocks: {
        topCells: [],
        blocks: [{
          x: 0, y: 0, hasParseFailure: false,
          subBlocks: [{
            x: 1, y: 1, hasParseFailure: false,
            cells: [{ formKey: 'c:A.esp', editorId: 'TheCell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }],
          }],
        }],
      },
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const [worldspaces] = await h.tree.getChildren(row);
    expect(worldspaces).toBeInstanceOf(WorldspacesNode);
    const [worldspace] = await h.tree.getChildren(worldspaces);
    expect(worldspace).toBeInstanceOf(WorldspaceNode);
    const [block] = await h.tree.getChildren(worldspace);
    expect(block).toBeInstanceOf(BlockNode);
    expect(expectInstanceOf(block, BlockNode).label).toBe('Block 0, 0');
    const [subBlock] = await h.tree.getChildren(block);
    expect(subBlock).toBeInstanceOf(SubBlockNode);
    expect(expectInstanceOf(subBlock, SubBlockNode).label).toBe('Sub-Block 1, 1');
    const [cell] = await h.tree.getChildren(subBlock);
    expect(cell).toBeInstanceOf(CellNode);
    expect(expectInstanceOf(cell, CellNode).label).toBe('TheCell');
  });

  it('nests the interior cells in xEdit\'s numbered blocks and sub-blocks', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'cell', count: 1, displayName: 'Cell' }],
      interiorCells: [{
        number: 3, hasParseFailure: false,
        subBlocks: [{
          number: 7, hasParseFailure: false,
          cells: [{ formKey: 'i:A.esp', editorId: 'Room', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }],
        }],
      }],
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const [interior] = await h.tree.getChildren(row);
    expect(interior).toBeInstanceOf(InteriorCellsNode);
    const [block] = await h.tree.getChildren(interior);
    expect(expectInstanceOf(block, InteriorBlockNode).label).toBe('Block 3');
    const [subBlock] = await h.tree.getChildren(block);
    expect(expectInstanceOf(subBlock, InteriorSubBlockNode).label).toBe('Sub-Block 7');
    const [cell] = await h.tree.getChildren(subBlock);
    expect(expectInstanceOf(cell, CellNode).label).toBe('Room');
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
    expect(expectInstanceOf(children[0], ErrorNode).label).toBe('Failed to load: boom');
  });

  it('forwards the record browser change events', () => {
    const h = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    h.tree.onDidChangeTreeData((e) => fired.push(e));

    h.records.refresh();

    expect(fired).toEqual([undefined]);
  });

  it('forwards the load order own change events', () => {
    const { tree } = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    tree.invalidate();

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
    worldspaces: [{ formKey: SHARED, editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
    worldspaceBlocks: {
      topCells: [{ formKey: '000802:Fallout4.esm', isPersistentWorldspaceCell: true, hasChildren: true, hasParseFailure: false }],
      blocks: [],
    },
    cellChildRecords: {
      persistent: [{ formKey: '000803:Fallout4.esm', editorId: 'DoorRef', recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    },
    interiorCells: [{
      number: 0, hasParseFailure: false,
      subBlocks: [{ number: 0, hasParseFailure: false, cells: [{ formKey: '000804:Fallout4.esm', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false }] }],
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
    const { tree } = await heldTree([A_ROW(), plugin({ name: 'Off.esp', slot: 1, enabled: false })]);

    const rows = await everyRow(tree);
    const states = rows.map((row) => tree.getTreeItem(row).collapsibleState);

    expect([...new Set(rows.map((row) => row.kind))].sort()).toEqual([
      'cell', 'interiorBlock', 'interiorCells', 'interiorSubBlock', 'placed', 'placedGroup', 'plugin', 'record',
      'recordType', 'worldspace', 'worldspaces',
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
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0, origin: 'ModA' })]));
    const h = await heldTree([plugin({ name: 'A.esp', slot: 0, origin: 'ModA' })], instance);
    const { tree } = h;
    const fromModA = recordRows(await everyRow(tree)).map((row) => row.id);

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0, origin: 'ModB' })]));
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
    formKey: 'c:A.esp', isPersistentWorldspaceCell: false, hasChildren: false, hasParseFailure: false, ...overrides,
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
      worldspaces: [{ formKey: '000100:A.esp', editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland', hasChildren: true, ...unreadable }],
      worldspaceBlocks: { topCells: [cell({ formKey: '000101:A.esp', editorId: 'TopCell', ...unreadable })], blocks: [] },
      cellChildRecords: {
        persistent: [{ formKey: '000301:A.esp', editorId: 'DoorRef', recordType: 'refr', ...unreadable }],
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
        { formKey: '000100:A.esp', editorId: 'Commonwealth', fullName: 'Commonwealth Wasteland', hasParseFailure: false, hasChildren: true },
        { formKey: '000200:A.esp', editorId: null, fullName: null, hasParseFailure: false, hasChildren: false },
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
      worldspaces: [{ formKey: '000100:A.esp', editorId: 'Commonwealth', hasParseFailure: false, hasChildren: true }],
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
      formKey: 'p:A.esp', recordType: 'refr', hasParseFailure: false, ...overrides,
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
      workingTreeState: 'None', recordType: 'dial', hasContainerChildren: false, hasParseFailure: false,
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

  it('states an untracked, editable plugin in a mod', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inUntrackedMod', 'untracked', 'editable']);
  });

  it('states a tracked, editable plugin in a tracked mod', async () => {
    const h = makeTree([A_ROW()], { instance: new FakeInstance({ ...valueOf([A_ROW()]), trackedMods: new Set(['SomeMod']) }) });
    await reconcile(h, [held('A.esp', { isTracked: true })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inTrackedMod', 'tracked', 'editable']);
  });

  it('states an untracked plugin in a tracked mod', async () => {
    const h = makeTree([A_ROW()], { instance: new FakeInstance({ ...valueOf([A_ROW()]), trackedMods: new Set(['SomeMod']) }) });
    await reconcile(h, [held('A.esp')]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inTrackedMod', 'untracked', 'editable']);
  });

  it('states a tracked plugin that is read-only for editing', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isTracked: true, isImmutable: true })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inUntrackedMod', 'tracked']);
  });

  it('states a plugin in Overwrite', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'overwrite' })]);
    await reconcile(h, [held('A.esp', { origin: 'overwrite' })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inOverwrite', 'untracked', 'editable']);
  });

  it('states neither a mod nor Overwrite for a plugin in the game folder', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'Data' })]);
    await reconcile(h, [held('A.esp', { origin: 'Data' })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'untracked', 'editable']);
  });

  it('states no mod for an origin the instance value names no mod folder for', async () => {
    const h = makeTree([A_ROW()], { instance: new FakeInstance(instanceValueFixture({ plugins: [A_ROW()] })) });
    await reconcile(h, [held('A.esp', { isTracked: true })]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'tracked', 'editable']);
  });

  it('states a disabled line', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'SomeMod', enabled: false })]);
    await reconcile(h, [held('A.esp')]);

    expect(await flags(h)).toEqual(['plugin', 'disabled', 'inUntrackedMod', 'untracked', 'editable']);
  });

  it('states neither tracked nor editable before mEdit answers', async () => {
    const h = makeTree([A_ROW()]);

    expect(await flags(h)).toEqual(['plugin', 'enabled', 'inUntrackedMod']);
  });

  it('says whether any plugin compiles, a read-only one included, which compile\'s palette entry reads', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    expect(h.tree.anyCompilable()).toBe(false);

    await reconcile(h, [held('A.esp'), held('B.esp')]);
    expect(h.tree.anyCompilable()).toBe(false);

    await reconcile(h, [held('A.esp'), held('B.esp', { isTracked: true, isImmutable: true })]);
    expect(h.tree.anyCompilable()).toBe(true);
  });
});

describe('PluginsTreeProvider — a plugin row\'s click', () => {
  it('opens the header of an enabled plugin', async () => {
    const h = makeTree([A_ROW()]);

    expect((await rowItem(h)).command?.command).toBe('modbench.record.open');
  });

  it('does nothing on a disabled plugin but select it', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'SomeMod', enabled: false })]);

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
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  it('matches read-only case-insensitively, like the load order set itself', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('a.ESP', { isImmutable: true })]);

    expect((await rowItem(h)).tooltip).toContain('read-only');
  });

  it('leaves an editable plugin tooltip at the base — file name and mod, no read-only line', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    expect((await rowItem(h)).tooltip).toBe('A.esp\nSomeMod');
  });

  it('stays through a fresh load start, until a new reconcile answers', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isImmutable: true })]);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    h.tree.applyIndexed([], []);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).tooltip).not.toContain('read-only');
  });

  it('never adds a read-only line to the locked row — its tooltip is the one sentence alone', async () => {
    const h = makeTree([], { loadedWithNoLine: ['Fallout4.esm'] });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data', isImmutable: true })]);

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

  it('matches the plugin key case-insensitively, like the load order set itself', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.ESP', { masterIssues: ['Ghost.esm'] })]);

    expect((await rowItem(h)).tooltip).toContain('Missing master');
  });

  it('never touches collapsibleState — AC2, and the leading slot stays the checkbox alone', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    const item = await rowItem(h);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.checkboxState).toBe(vscode.TreeItemCheckboxState.Checked);
  });

  it('leaves an unaffected plugin row undecorated', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [
      held('A.esp', { masterIssues: ['Ghost.esm'] }),
      held('B.esp'),
    ]);

    const item = await rowItem(h, 1);
    expect(item.tooltip).toBe('B.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });

  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);
    expect((await rowItem(h)).tooltip).toContain('Missing master');

    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  it('shows no master status while mEdit has not checked the masters', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, null);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });

  it('keeps the last master issues through a read taken before the next snapshot is indexed', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm']);

    h.client.setQueryAnswer('getPlugins', [held('A.esp', { masterIssues: null })]);
    await h.tree.refreshFacts();

    expect((await rowItem(h)).description).toBe('1 master issue');
  });

  it('counts the masters that are not active, and names them on one tooltip line in MO2 words', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, ['Ghost.esm', 'Disabled.esm']);

    const item = await rowItem(h);
    expect(item.description).toBe('2 master issues');
    expect(item.tooltip).toBe('A.esp\nSomeMod\nMissing masters: Ghost.esm, Disabled.esm');
  });

  it('leaves a row the backend flags nothing on undecorated', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, []);

    expect((await rowItem(h)).tooltip).toBe('A.esp\nSomeMod');
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

  it('never abandons the row: it stays collapsible, but expands to the error node — it will never be indexed', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    expect((await rowItem(h)).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);
    expect(children).toEqual([expect.any(ErrorNode)]);
    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('Malformed record');
  });

  it('matches the plugin, name and origin, case-insensitively', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.ESP', origin: 'SOMEMOD', reason: 'Malformed record' }]);

    expect((await rowItem(h)).tooltip).toContain('Failed to read');
  });

  it('keeps the failed-to-read status (no blink) while expansion still reads "still indexing" for an unreached plugin', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);
    expect((await rowItem(h)).description).toBe('failed to read');

    h.tree.applyIndexed([], []);

    expect((await rowItem(h)).description).toBe('failed to read');
    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('clears the failed tooltip once a later reconcile reports the plugin loaded', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);
    expect((await rowItem(h)).tooltip).toContain('Failed to read');

    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });

  it('leaves an unaffected plugin row undecorated', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('B.esp')], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    const item = await rowItem(h, 1);
    expect(item.tooltip).toBe('B.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });
});

describe('PluginsTreeProvider — parse-failure decoration', () => {
  it('flags a plugin holding an unreadable record, and leaves every other row alone', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasParseFailure: true }), held('B.esp')]);

    const flagged = await rowItem(h);
    expect(expectInstanceOf(flagged.iconPath, ThemeIcon).id).toBe('error');
    expect(flagged.description).toBe('unreadable records');
    expect(flagged.tooltip).toContain('could not be read');
    expect((await rowItem(h, 1)).iconPath).toBeUndefined();
  });

  it('clears once a later reconcile reports the plugin whole', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasParseFailure: true })]);
    expect((await rowItem(h)).iconPath).toBeDefined();

    await reconcile(h, [held('A.esp')]);

    expect((await rowItem(h)).iconPath).toBeUndefined();
  });
});

describe('PluginsTreeProvider — malformed-plugin diagnosis decoration', () => {
  const REGN = 'REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8';

  it('decorates a plugin whose only status is malformed with the warning icon, the word malformed and the diagnosis text', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.ESP', REGN)]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsWarningIcon.foreground'));
    expect(item.description).toBe('malformed');
    expect(item.tooltip).toContain('RDAT is 6 bytes');
  });

  it('two diagnoses on one plugin read as the same fixed word, with both in the tooltip line', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'first diagnosis'), diagnosis('A.esp', 'second diagnosis')]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.description).toBe('malformed');
    expect(item.tooltip).toContain('first diagnosis');
    expect(item.tooltip).toContain('second diagnosis');
  });

  it('keeps the last diagnoses through a reconcile until its own scan lands', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).description).toBe('malformed');

    let resolveScan!: (reports: PluginDiagnosisReport[]) => void;
    const slow = new Promise<PluginDiagnosisReport[]>((resolve) => { resolveScan = resolve; });
    h.client.setQueryAnswerOnce('getDiagnoses', slow);

    await h.tree.applyReconciled([]);
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

    h.client.setQueryFailure('getDiagnoses', new Error('GET /plugins/diagnoses failed (503)'));
    await reconcile(h, [held('A.esp')]);

    expect((await rowItem(h)).description).toBe('malformed');
  });

  it('a reconcile clears the previous scan diagnoses when the new scan finds nothing', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).description).toBe('malformed');

    h.client.setQueryAnswer('getDiagnoses', []);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('A.esp\nSomeMod');
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

  it('clears once a later settle of the mod leaves it out', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    settled(h, 'SomeMod', 'A.esp');

    settled(h, 'SomeMod');

    const item = await rowItem(h);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('A.esp\nSomeMod');
  });

  it('leaves the same file name in another mod alone', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    settled(h, 'OtherMod', 'A.esp');

    expect((await rowItem(h)).description).toBeUndefined();
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

describe('PluginsTreeProvider — several statuses on one row', () => {
  it('shows all five statuses: the first status\'s icon, every status\'s words, one tooltip line each', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(
      h,
      [held('A.esp', { hasParseFailure: true, masterIssues: ['Ghost.esm'] })],
      [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }],
    );
    h.client.emit({
      kind: 'external-change', plugin: '', origin: 'SomeMod', keys: [], sequence: 0,
      changedPlugins: [{ name: 'A.esp', bytesSha256: null }],
    });

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('failed to read, 1 master issue, unreadable records, changed outside Modbench, malformed');
    const tooltip = tooltipAsString(item.tooltip);
    expect(tooltip).toContain('Failed to read: Malformed record');
    expect(tooltip).toContain('Missing masters: Ghost.esm');
    expect(tooltip).toContain('could not be read');
    expect(tooltip).toContain('Changed outside Modbench');
    expect(tooltip).toContain('some diagnosis');
  });

  it('sets the icon from the first present status, skipping ones this row does not carry', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      hasParseFailure: true,
      masterIssues: ['Ghost.esm'],
    })]);

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('1 master issue, unreadable records');
  });

  it('carries the read-only line alongside a status', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      isImmutable: true,
      masterIssues: ['Ghost.esm'],
    })]);

    const item = await rowItem(h);
    expect(item.description).toBe('1 master issue');
    expect(item.tooltip).toContain('read-only');
    expect(item.tooltip).toContain('Missing masters: Ghost.esm');
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

    await h.tree.refreshFacts();

    expect(heard).toHaveLength(1);
    expect((await h.tree.getChildren())[0]).toBe(before[0]);
  });
});

describe('PluginsTreeProvider — a name under two origins joins to the row own origin, replies listing the row\'s own plugin first so a name-only join would answer with the other', () => {
  const SHARED_ROW = () => plugin({ name: 'Shared.esp', slot: 0, origin: 'ModA' });

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

    expect((await rowItem(h)).iconPath).toBeUndefined();
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
    const h = makeTree([SHARED_ROW(), plugin({ name: 'Shared.esp', slot: 0, origin: 'ModB', winning: false })]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModA' })],
      [{ name: 'Shared.esp', origin: 'ModB', reason: 'Malformed record' }]);

    const rows = await h.tree.getChildren();
    expect(rows).toHaveLength(1);
    const item = h.tree.getTreeItem(present(rows[0], 'the sole row'));
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('Shared.esp\nModA');
  });

  it('expands the row as still indexing while only the other plugin has landed', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.tree.applyIndexed([{ name: 'Shared.esp', origin: 'ModB' }], []);

    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('expands the row as still indexing while mEdit holds only the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModB' })]);

    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('expands the winning row as still indexing, never into the other plugin failure', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.tree.applyIndexed([], [{ name: 'Shared.esp', origin: 'ModB', reason: 'Malformed record' }]);

    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('flags the row when its own plugin failed to read and the other plugin loaded', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModB' })],
      [{ name: 'Shared.esp', origin: 'ModA', reason: 'Malformed record' }]);

    expect((await rowItem(h)).description).toBe('failed to read');
  });

  it('joins case-insensitively on the origin as well as the name', async () => {
    const h = makeTree([plugin({ name: 'Shared.esp', slot: 0, origin: 'MODA' })]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'moda', masterIssues: ['AMaster.esm'] }),
      held('Shared.esp', { origin: 'ModB' }),
    ]);

    expect((await rowItem(h)).tooltip).toContain('AMaster.esm');
  });

  it('states nothing of another plugin of the name when the row origin matches no plugin the answer names', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'RenamedMod' })]);
    await reconcile(h, [held('A.esp', {
      origin: 'SomeOtherMod', isImmutable: true, masterIssues: ['Ghost.esm'],
    })]);

    expect((await rowItem(h)).tooltip).toBe('A.esp\nRenamedMod');
  });
});

describe('PluginsTreeProvider — the facts are pulled once and held', () => {
  it('reads the plugin list once per reconcile, not once per rendered row', async () => {
    const h = makeTree([A_ROW(), B_ROW(), plugin({ name: 'C.esp', slot: 2 })]);
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

    await h.tree.refreshFacts();

    expect(callCount(h.client, 'getPlugins')).toBe(2);
  });

  it('reports a failed plugin read at error, naming the reason once', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryFailure('getPlugins', new Error('GET /plugins failed (503)'));

    await h.tree.applyReconciled([]);

    const failures = h.logged.filter((l) => l.msg.includes('plugin list failed'));
    expect(failures).toHaveLength(1);
    expect(present(failures[0], 'the sole logged failure').level).toBe('error');
    expect(present(failures[0], 'the sole logged failure').msg).toContain('GET /plugins failed (503)');
  });

  it('reports a failed malformed-plugin scan at warn, below the read that succeeded', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryFailure('getDiagnoses', new Error('GET /plugins/diagnoses failed (503)'));

    await reconcile(h, [held('A.esp')]);

    const scan = h.logged.filter((l) => l.msg.includes('malformed-plugin scan'));
    expect(scan).toHaveLength(1);
    expect(present(scan[0], 'the sole scan-failure log entry').level).toBe('warn');
    expect(h.logged.some((l) => l.level === 'error')).toBe(false);
  });

  it('drops a reconcile answer that lands after a fresh load started', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getPlugins', [held('A.esp')]);
    const landing = h.tree.applyReconciled([]);
    h.tree.applyIndexed([], []);

    expect(await landing).toBeUndefined();
    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
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

    const row = expectInstanceOf(await tree.recordRow(NPCS, NEW_NPC), RecordNode);

    expect(row.record.formKey).toBe('000900:A.esp');
  });

  it('walks from the record\'s row up through its group to its plugin row, and no further', async () => {
    const { tree } = await heldWith(listing('000900:A.esp'));
    const row = present(await tree.recordRow(NPCS, NEW_NPC), 'the new record\'s row');

    const group = expectInstanceOf(tree.getParent(row), RecordTypeNode);
    const pluginRow = expectInstanceOf(tree.getParent(group), PluginNode);

    expect([group.recordType, pluginRow.plugin.name, tree.getParent(pluginRow)]).toEqual(['npc_', 'A.esp', undefined]);
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
});

describe('PluginsTreeProvider — a move by drop ends when the read lands (common.md, A gesture that writes)', () => {
  beforeEach(() => { progressSteps.length = 0; });

  const LINES = ['A.esp', 'B.esp', 'C.esp'];
  const valueOver = (names: readonly string[]): InstanceValue =>
    valueOf(names.map((name, slot) => plugin({ name, slot })));
  const node = (name: string) => new PluginNode({ name, enabled: true }, 'SomeMod');
  const rows = async (tree: PluginsTreeProvider): Promise<string[]> =>
    (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode).map((row) => row.plugin.name);

  class ReadingInstance extends FakeInstance {
    override refresh(): Promise<void> {
      progressSteps.push('Instance loader: read every file again');
      return super.refresh();
    }
  }

  function treeOver(instance: FakeInstance, source: PluginListSource = new FakeSource()) {
    return new PluginsTreeProvider({ instance, source, reporter: recordingReporter() });
  }

  async function drop(tree: PluginsTreeProvider, moved: string, target: string | undefined): Promise<void> {
    const dt = new DataTransfer();
    tree.handleDrag([node(moved)], dt, IGNORED_TOKEN);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, IGNORED_TOKEN);
  }

  it('shows the progress bar from the drop until the read after the write lands', async () => {
    const source: PluginListSource = {
      reorderPlugins: () => { progressSteps.push('write plugins.txt'); return Promise.resolve(); },
    };
    const tree = treeOver(new ReadingInstance(valueOver(LINES)), source);
    await tree.getChildren();

    await drop(tree, 'A.esp', undefined);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'write plugins.txt',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('shows the order the read holds, not the one dropped', async () => {
    const instance = new ReadingInstance(valueOver(LINES));
    const tree = treeOver(instance);
    await tree.getChildren();

    await drop(tree, 'A.esp', undefined);
    expect(await rows(tree)).toEqual(LINES);

    instance.value = valueOver(['B.esp', 'C.esp', 'A.esp']);
    await instance.refresh();
    expect(await rows(tree)).toEqual(['B.esp', 'C.esp', 'A.esp']);
  });

  it('still ends on the read when the write fails', async () => {
    const source = new FakeSource();
    source.reorderPluginsError = new Error('locked');
    const tree = treeOver(new ReadingInstance(valueOver(LINES)), source);
    await tree.getChildren();

    await drop(tree, 'A.esp', undefined);

    expect(progressSteps).toEqual([
      'progress opens on modbench.pluginListTree',
      'Instance loader: read every file again',
      'progress closes',
    ]);
  });

  it('opens no progress and reads nothing for a drop that goes nowhere', async () => {
    const tree = treeOver(new ReadingInstance(valueOver(LINES)));
    await tree.getChildren();

    await drop(tree, 'A.esp', 'A.esp');

    expect(progressSteps).toEqual([]);
  });
});

describe('PluginsTreeProvider — an unconfirmed record create, copy or delete', () => {
  afterEach(() => { vi.useRealTimers(); });

  const A = { name: 'A.esp', origin: 'SomeMod' };
  const B = { name: 'B.esp', origin: 'SomeMod' };
  const RECORD = { formKey: '000001:A.esp', plugin: 'A.esp', origin: 'SomeMod' };
  const NAMED = new Map([[RECORD.formKey, 'TheWeapon']]);

  async function treeWithARecord(): Promise<Harness> {
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1 }],
      records: { items: [recordSummary()], total: 1 },
    });
    client.setQueryAnswer('getRecordHolders', [A]);
    const h = makeTree([A_ROW(), B_ROW()], { client });
    await reconcile(h, [held('A.esp'), held('B.esp')]);
    vi.useFakeTimers();
    return h;
  }

  const spins = (h: Harness, node: PluginsTreeNode): boolean => {
    const icon = h.tree.getTreeItem(node).iconPath;
    return icon instanceof ThemeIcon && icon.id === 'sync~spin';
  };
  const plugins = async (h: Harness) => (await h.tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
  const pluginRow = async (h: Harness, name: string) => present((await plugins(h)).find((n) => n.plugin.name === name), name);
  const groupRow = async (h: Harness) => expectInstanceOf((await h.tree.getChildren(await pluginRow(h, 'A.esp')))[0], RecordTypeNode);
  const recordRow = async (h: Harness) => expectInstanceOf((await h.tree.getChildren(await groupRow(h)))[0], RecordNode);
  const marked = async (h: Harness): Promise<string[]> => {
    const rows: [string, PluginsTreeNode][] = [
      ...(await plugins(h)).map((row): [string, PluginsTreeNode] => [row.plugin.name, row]),
      ['group', await groupRow(h)], ['record', await recordRow(h)],
    ];
    return rows.filter(([, row]) => spins(h, row)).map(([name]) => name);
  };
  const rowsChanged = async (h: Harness, plugin: { name: string; origin: string }, ...keys: string[]) => {
    h.client.emit({ kind: 'rows-changed', plugin: plugin.name, origin: plugin.origin, keys, sequence: 1 });
    await vi.advanceTimersByTimeAsync(0);
  };
  const refreshed = async (h: Harness) => {
    await h.tree.applyReconciled([]);
    await vi.advanceTimersByTimeAsync(0);
  };
  const shown = () => vi.advanceTimersByTimeAsync(1000);
  const warnings = (h: Harness) => h.logged.filter((l) => l.level === 'warn').map((l) => l.msg);

  describe('a delete', () => {
    it('keeps the record\'s row, and marks it alone only after a delay', async () => {
      const h = await treeWithARecord();

      h.tree.recordMarks.deleting([RECORD], NAMED);

      expect(await marked(h)).toEqual([]);
      await shown();
      expect(await marked(h)).toEqual(['record']);
      expect(h.tree.getTreeItem(await recordRow(h)).tooltip).toBe('Written; waiting for the disk to confirm');
    });

    it('keys the mark on (origin, filename): the record of a plugin of the same name elsewhere is untouched', async () => {
      const h = await treeWithARecord();

      h.tree.recordMarks.deleting([{ ...RECORD, origin: 'OtherMod' }], NAMED);
      await shown();

      expect(await marked(h)).toEqual([]);
    });

    it('goes, with nothing said, once mEdit reports the record gone from the plugin', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).answered([RECORD]);
      await shown();

      h.client.setQueryAnswer('getRecordHolders', [B]);
      await rowsChanged(h, A, RECORD.formKey);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });

    it('stays through a report that still holds it, then logs one line naming the record on the next and goes', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).answered([RECORD]);
      await shown();

      await rowsChanged(h, A, RECORD.formKey);
      expect(await marked(h)).toEqual(['record']);

      await rowsChanged(h, A, RECORD.formKey);
      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] TheWeapon [000001:A.esp] was deleted from "A.esp", and the disk still holds it.']);
    });

    it('ignores a report of another plugin or another record', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).answered([RECORD]);
      await shown();
      h.client.setQueryAnswer('getRecordHolders', [B]);

      await rowsChanged(h, B, RECORD.formKey);
      await rowsChanged(h, A, '000002:A.esp');

      expect(await marked(h)).toEqual(['record']);
    });

    it('stays while mEdit cannot be read', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).answered([RECORD]);
      await shown();

      h.client.setQueryFailure('getRecordHolders', new Error('mEdit is not answering'));
      await rowsChanged(h, A, RECORD.formKey);

      expect(await marked(h)).toEqual(['record']);
      expect(warnings(h)).toEqual([]);
    });

    it('shows no mark for a record the delete refused, on the row it was shown on too', async () => {
      const h = await treeWithARecord();
      const marks = h.tree.recordMarks.deleting([RECORD], NAMED);
      await shown();
      const row = await recordRow(h);
      expect(spins(h, row)).toBe(true);

      marks.answered([]);

      expect(spins(h, row)).toBe(false);
      expect(h.tree.getTreeItem(row).tooltip).toBeUndefined();
      expect(await marked(h)).toEqual([]);
    });

    it('goes on a refresh, which says once that the disk still holds it', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).answered([RECORD]);
      await shown();

      await refreshed(h);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] TheWeapon [000001:A.esp] was deleted from "A.esp", and the disk still holds it.']);
    });

    it('with no answer, keeps the mark through a report of another record, and goes, saying nothing, on one of its own that shows it gone', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).unanswered();
      await shown();

      await rowsChanged(h, A, '000002:A.esp');
      expect(await marked(h)).toEqual(['record']);

      h.client.setQueryAnswer('getRecordHolders', [B]);
      await rowsChanged(h, A, RECORD.formKey);
      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });

    it('with no answer, says once that the disk still holds the record when mEdit\'s reports do', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).unanswered();
      await shown();

      await rowsChanged(h, A, RECORD.formKey);
      await rowsChanged(h, A, RECORD.formKey);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] TheWeapon [000001:A.esp] was deleted from "A.esp", and the disk still holds it.']);
    });

    it('with no answer, goes on a refresh, saying nothing', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.deleting([RECORD], NAMED).unanswered();
      await shown();

      await refreshed(h);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });
  });

  describe('a create', () => {
    it('marks the plugin row it was made from, or the group row, only after a delay', async () => {
      const h = await treeWithARecord();

      h.tree.recordMarks.creating({ plugin: A });
      h.tree.recordMarks.creating({ plugin: B, recordType: 'weap' });
      h.tree.recordMarks.creating({ plugin: A, recordType: 'weap' });
      expect(await marked(h)).toEqual([]);

      await shown();
      expect(await marked(h)).toEqual(['A.esp', 'group']);
    });

    it('goes when mEdit already holds the new record as the answer lands', async () => {
      const h = await treeWithARecord();
      const marks = h.tree.recordMarks.creating({ plugin: A });
      await shown();

      h.client.setQueryAnswer('getRecordHolders', [A]);
      marks.answered('000800:A.esp');
      await vi.advanceTimersByTimeAsync(0);

      expect(await marked(h)).toEqual([]);
    });

    it('stays until mEdit reports the new record, and logs when the report does not hold it', async () => {
      const h = await treeWithARecord();
      const marks = h.tree.recordMarks.creating({ plugin: A });
      h.client.setQueryAnswer('getRecordHolders', []);
      marks.answered('000800:A.esp');
      await shown();
      expect(await marked(h)).toEqual(['A.esp']);

      await rowsChanged(h, A, '000800:A.esp');
      await rowsChanged(h, A, '000800:A.esp');

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] 000800:A.esp was created in "A.esp", and the disk does not hold it.']);
    });

    it('shows no mark when the create is refused', async () => {
      const h = await treeWithARecord();

      h.tree.recordMarks.creating({ plugin: A }).answered(undefined);
      await shown();

      expect(await marked(h)).toEqual([]);
    });

    it('with no answer, keeps the mark until mEdit next reports the plugin, saying nothing', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.creating({ plugin: A }).unanswered();
      await shown();

      await rowsChanged(h, B, '000800:B.esp');
      expect(await marked(h)).toEqual(['A.esp']);

      await rowsChanged(h, A, '000800:A.esp');
      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });

    it('goes on a refresh while the create waits for its answer, or had none', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.creating({ plugin: A });
      h.tree.recordMarks.creating({ plugin: A, recordType: 'weap' }).unanswered();
      await shown();

      await refreshed(h);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });
  });

  describe('a copy', () => {
    const INTO_B = { record: RECORD, destination: B };

    it('marks each destination\'s row only after a delay, and goes once mEdit holds the copy there', async () => {
      const h = await treeWithARecord();
      const marks = h.tree.recordMarks.copying([INTO_B], 'New', [], NAMED);
      expect(await marked(h)).toEqual([]);
      await shown();
      expect(await marked(h)).toEqual(['B.esp']);

      h.client.setQueryAnswer('getRecordHolders', [B]);
      marks.answered([{ ...INTO_B, newFormKey: '000900:B.esp' }]);
      await vi.advanceTimersByTimeAsync(0);

      expect(await marked(h)).toEqual([]);
      expect(h.client.calls.filter((c) => c.method === 'getRecordHolders').map((c) => c.args)).toEqual([['000900:B.esp']]);
    });

    it('logs, naming the record, when mEdit reports the copy and does not hold it', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.copying([INTO_B], 'New', [], NAMED).answered([INTO_B]);
      await shown();

      await rowsChanged(h, B, RECORD.formKey);
      await rowsChanged(h, B, RECORD.formKey);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] TheWeapon [000001:A.esp] was copied into "B.esp", and the disk does not hold the copy.']);
    });

    it('shows no mark for a copy the destination refused', async () => {
      const h = await treeWithARecord();

      h.tree.recordMarks.copying([INTO_B], 'New', [], NAMED).answered([]);
      await shown();

      expect(await marked(h)).toEqual([]);
    });

    it('keeps a replacing copy\'s mark while the destination holds the record from before the write, until mEdit reports it there', async () => {
      const h = await treeWithARecord();
      h.client.setQueryAnswer('getRecordHolders', [A, B]);
      h.tree.recordMarks.copying([INTO_B], 'Override', [INTO_B], NAMED).answered([INTO_B]);
      await shown();
      expect(await marked(h)).toEqual(['B.esp']);

      await rowsChanged(h, B, RECORD.formKey);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });

    it('as an override with no answer, says once that the disk does not hold the copy when mEdit\'s reports do', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.copying([INTO_B], 'Override', [], NAMED).unanswered();
      await shown();

      await rowsChanged(h, B, RECORD.formKey);
      await rowsChanged(h, B, RECORD.formKey);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual(['[PluginsTreeProvider] TheWeapon [000001:A.esp] was copied into "B.esp", and the disk does not hold the copy.']);
    });

    it('as a new record with no answer, keeps the mark until a refresh, saying nothing', async () => {
      const h = await treeWithARecord();
      h.tree.recordMarks.copying([INTO_B], 'New', [], NAMED).unanswered();
      await shown();
      expect(await marked(h)).toEqual(['B.esp']);

      await refreshed(h);

      expect(await marked(h)).toEqual([]);
      expect(warnings(h)).toEqual([]);
    });
  });
});
