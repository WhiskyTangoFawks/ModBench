import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reorderPlugins, type PluginsDrop } from '../../pluginsCommands/plugins';
import { parsePlugins } from '../../mo2Codecs/pluginsText';
import type { LoadOrderPlugin, LoadOrderPluginLine } from '../../instanceLoader/loadOrderSnapshot';
import type { InstanceValue } from '../../instanceLoader/instance';
import {
  InMemoryMEditClient, type PluginDiagnosisReport, type PluginLoadFailure, type PluginMetadata, type RecordPage,
  type WorldspaceSummary, type WorldspaceBlocks, type CellPage, type RecordSummary,
} from '../../client';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  uriFile, uriFrom, DataTransferItem, DataTransfer, FakeCancellationToken,
} from '../../test/vscodeMock';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => ({
  ...fakeVscodeModule(),
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon, ThemeColor,
  Uri: { file: uriFile, from: uriFrom }, DataTransferItem, DataTransfer,
}));

import * as vscode from 'vscode';
import {
  PluginsTreeProvider, PluginNode, ImplicitMasterNode, EmptyNode, pluginFileOf, isDropPayload,
  type PluginListSource, type PluginsTreeProviderOptions,
} from '../PluginsTreeProvider';
import {
  PluginTreeProvider, RecordTypeNode, RecordNode, WorldspacesNode, WorldspaceNode, BlockNode,
  SubBlockNode, CellNode, InteriorCellsNode, InteriorLoadMoreNode, IndexingNode,
} from '../PluginTreeProvider';
import { ErrorNode } from '../errorNode';
import { recordingReporter } from '../../test/surfacingDoubles';
import { withUnreadCorpusInstance } from '../../test/mo2/unreadCorpusInstance';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { present } from '../../ports/present';

// ── fixtures ─────────────────────────────────────────────────────────────────

// A minimal fixture builder: only the fields a given test cares about need overriding.
// `path: undefined` fixtures a `LoadOrderPluginLine` — a listed name with no game directory to
// resolve it against.
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

// Only `.plugins` is ever read for rows — the rest of InstanceValue is Mods-tree/Downloads
// territory.
function valueOf(plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]): InstanceValue {
  return instanceValueFixture({ plugins });
}

// A hang must fail on an explicit assertion, not the test runner's own timeout.
const within = <T>(pending: Promise<T>, ms: number): Promise<T> => Promise.race([
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

// What the composition root binds: the reorder command against one instance root and profile.
const writesTo = (instanceRoot: string): PluginListSource => ({
  reorderPlugins: async (names, drop) => {
    const result = await reorderPlugins(instanceRoot, 'Default', names, drop);
    if (!result.applied) throw new Error(result.refusal);
  },
});

// One `GET /plugins` row: held and unremarkable unless a test overrides it.
function held(name: string, overrides: Partial<PluginMetadata> = {}): PluginMetadata {
  return {
    name,
    path: `/data/${name}`,
    loadOrderIndex: 0,
    isLight: false,
    isMaster: false,
    masters: [],
    recordCount: 0,
    isImmutable: false,
    participates: true,
    origin: 'SomeMod',
    masterIssues: [],
    inLoadOrder: true,
    enabled: true,
    winning: true,
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
  recordTypes: { type: string; count: number; displayName?: string; hasParseFailure?: boolean }[];
  records: RecordPage;
  worldspaces: WorldspaceSummary[];
  worldspaceBlocks: WorldspaceBlocks;
  interiorCells: CellPage;
}> = {}): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlugins', overrides.plugins ?? []);
  client.setQueryAnswer('getDiagnoses', overrides.diagnoses ?? []);
  client.setQueryAnswer('getRecordTypes', (overrides.recordTypes ?? []).map((rt) => ({
    type: rt.type, count: rt.count, displayName: rt.displayName ?? rt.type, hasParseFailure: rt.hasParseFailure ?? false,
  })));
  client.setQueryAnswer('getRecords', overrides.records ?? { items: [], total: 0 });
  client.setQueryAnswer('getWorldspaces', overrides.worldspaces ?? []);
  client.setQueryAnswer('getWorldspaceBlocks', overrides.worldspaceBlocks ?? { blocks: [], topCells: [] });
  client.setQueryAnswer('getCellReferences', { persistent: [], temporary: [] });
  client.setQueryAnswer('getContainerChildren', []);
  client.setQueryAnswer('getInteriorCells', overrides.interiorCells ?? { items: [], total: 0 });
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
    dataFolderFile: (name: string) => string | undefined;
    implicitMasters: () => Promise<readonly string[] | undefined>;
    reporter: PluginsTreeProviderOptions['reporter'];
  }> = {},
): Harness {
  const instance = extra.instance ?? new FakeInstance(valueOf(plugins));
  const source = extra.source ?? new FakeSource();
  const client = extra.client ?? makeClient();
  const records = new PluginTreeProvider(client);
  const logged: { level: string; msg: string }[] = [];
  const tree = new PluginsTreeProvider({
    instance, source, client, records,
    log: (level, msg) => logged.push({ level, msg }),
    publishDiagnoses: extra.publishDiagnoses,
    dataFolderFile: extra.dataFolderFile,
    implicitMasters: extra.implicitMasters,
    reporter: extra.reporter,
  });
  return { tree, client, records, instance, source, logged };
}

// A reconcile is what fills the tree's facts; every decoration test drives it rather than
// pushing a fact in by hand. The malformed-plugin scan is fire-and-forget, so its microtasks
// are drained here before anything is asserted.
async function reconcile(
  h: Harness, plugins: PluginMetadata[], failures: PluginLoadFailure[] = [],
): Promise<void> {
  h.client.setQueryAnswer('getPlugins', plugins);
  await h.tree.applyReconciled(failures);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Recorded calls to one query, replacing the old per-method counter: "one read per reconcile"
// is asserted against the adapter's own call log, not a hand-rolled tally.
function callCount(client: InMemoryMEditClient, method: string): number {
  return client.calls.filter((c) => c.method === method).length;
}

// ── row nodes ────────────────────────────────────────────────────────────────

// The leading slot answers one question: can you change whether this loads? A lock fills it
// where a togglable row renders a checkbox, since the platform has no non-interactive checkbox
// variant.
describe('ImplicitMasterNode — leading slot', () => {
  it('renders a lock icon, not a checkbox', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.iconPath).toEqual({ id: 'lock' });
    expect(node.checkboxState).toBeUndefined();
  });

  // plugins.md: MO2's one sentence alone — the label already shows the file name.
  it('tooltip is MO2\'s one sentence alone, with no file name', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.tooltip).toBe("This plugin can't be disabled or moved (enforced by the game).");
  });

  it('keys resourceUri on the given path, for the label-graying decoration provider', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', '/game/Data/Fallout4.esm');
    expect(node.resourceUri?.path).toBe('/game/Data/Fallout4.esm');
  });

  it('leaves resourceUri undefined when no path is given (test-construction convenience)', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.resourceUri).toBeUndefined();
  });
});

// xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
describe('PluginNode / ImplicitMasterNode — row click opens the plugin header', () => {
  it('PluginNode wires .command to modbench.openHeader, passing itself', () => {
    const node = new PluginNode({ name: 'TestMod.esp', enabled: true });
    expect(node.command).toEqual({ command: 'modbench.openHeader', title: 'Open Header', arguments: [node] });
  });

  it('ImplicitMasterNode wires .command to modbench.openHeader, passing itself', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.command).toEqual({ command: 'modbench.openHeader', title: 'Open Header', arguments: [node] });
  });
});

// ErrorNode and IndexingNode replace whatever row they stand in for; their checkbox/lock
// absence is worth guarding here too, alongside EmptyNode's.
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

  it('EmptyNode has no checkbox and no lock', () => {
    const node = new EmptyNode();
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });
});

// Every master verdict is the backend's, applied over these rows: a row carries no badge of its
// own (ADR-0016).
describe('PluginNode', () => {
  it('renders a plain row — no icon, no description', () => {
    const node = new PluginNode({ name: 'A.esp', enabled: true });
    expect(node.iconPath).toBeUndefined();
    expect(node.description).toBeUndefined();
  });

  it('carries the origin of the plugin the row stands for (ADR-0012)', () => {
    expect(new PluginNode({ name: 'A.esp', enabled: true }, 'WinnerMod').origin).toBe('WinnerMod');
  });
});

// ── rows ─────────────────────────────────────────────────────────────────────

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
    expect(expectInstanceOf(rows[0], PluginNode).checkboxState).toBe(0); // Unchecked
    expect(expectInstanceOf(rows[1], PluginNode).label).toBe('B.esp');
    expect(expectInstanceOf(rows[1], PluginNode).checkboxState).toBe(1); // Checked
  });

  it('renders a single "No plugins" node when the Instance value carries none', async () => {
    const { tree } = makeTree([]);
    const rows = await tree.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
    expect(expectInstanceOf(rows[0], EmptyNode).label).toBe('No plugins');
  });

  // Rival: the provider falls back to some read path of its own instead of the injected value.
  // With that rival, this fixture's rows would be empty/wrong rather than what the value says.
  it('rows exactly match the fixture value — not a re-derivation', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Zed.esp', slot: 0, enabled: true }),
      plugin({ name: 'Aardvark.esp', slot: 1, enabled: false }),
    ]);
    const rows = await tree.getChildren();
    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Zed.esp', 'Aardvark.esp']); // file order
  });

  it('carries each row\'s own origin from the Instance value', async () => {
    const { tree } = makeTree([
      plugin({ name: 'A.esp', slot: 0, origin: 'ModA' }),
      plugin({ name: 'B.esp', slot: 1, origin: 'overwrite' }),
    ]);
    const rows = expectInstancesOf(await tree.getChildren(), PluginNode);
    expect(rows.map((r) => r.origin)).toEqual(['ModA', 'overwrite']);
  });

  // An overridden plugin of a listed name carries the same slot as the winning one (ADR-0013) — it
  // must not become a second row for that name.
  it('an overridden plugin of a listed name renders no row of its own', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0, origin: 'Winner', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', winning: false }),
    ]);
    const rows = (await tree.getChildren()).filter((n) => n instanceof PluginNode);
    expect(rows).toHaveLength(1);
  });

  // A plugin file an enabled mod provides with no plugins.txt line (`slot: null`) is the
  // plugin sync's business, never merged in here.
  it('an unlisted plugin (slot: null) gets no row', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0 }),
      plugin({ name: 'Unlisted.esp', slot: null, winning: true }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Base.esp']);
  });

  // A listed name no mod provides (e.g. a vanilla master) still gets a row when no game
  // directory is configured — only its path resolution, and any badge relying on it, degrade.
  it('still renders a row for a listed name no mod provides, when the Data folder is unresolved', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: '/unresolved/Fallout4.esm' }),
      plugin({ name: 'Mod.esp', slot: 1, origin: 'SomeMod' }),
    ], { dataFolderFile: () => undefined });

    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm', 'Mod.esp']);
  });

  // The real shape an unresolved game directory produces (`LoadOrderPluginLine`): a row with no
  // `path` at all, not a placeholder string. The row still renders, unbadged.
  it('renders a row for a LoadOrderPluginLine (path: undefined), with no badge', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: undefined }),
    ]);
    const rows = (await tree.getChildren()).filter((n): n is PluginNode => n instanceof PluginNode);
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm']);
    expect(present(rows[0], 'the LoadOrderPluginLine row').iconPath).toBeUndefined(); // no path to open, so nothing to badge
  });

  it('resolvePluginPath returns undefined for a LoadOrderPluginLine, never "undefined" as text', async () => {
    const { tree } = makeTree([plugin({ name: 'Fallout4.esm', slot: 0, path: undefined })]);
    expect(await tree.resolvePluginPath('Fallout4.esm')).toBeUndefined();
  });

  // Rival: subscribe but drop the callback, or never subscribe — rows would stay at the value
  // handed to the constructor.
  it('re-renders on a new value published after construction', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const { tree } = makeTree([], { instance });
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);

    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]));

    expect(fired).toBe(true); // not just the first render — a second, later value re-renders too
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  it('invalidate() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const { tree } = makeTree([plugin({ name: 'A.esp', slot: 0 })]);
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });
    tree.invalidate();
    expect(fired).toBe(true);
  });

  // Asymmetry test: invalidate() re-pulls the Instance's current value and clears the row
  // cache — unlike setFilter's render-only path, which must leave both alone.
  it('invalidate() clears the cache and re-pulls the current instance value', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const { tree } = makeTree([], { instance });
    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);

    instance.value = valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]); // no publish()

    tree.invalidate();

    expect((await tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  // The empty value before the first read is "not read yet", never "No plugins": a render asked
  // for before the read, and awaited after it, shows the rows that read lands.
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

  // The timeout is the finding: a gate that settles only on a landed value leaves a first read
  // that threw spinning forever (ADR-0019).
  it('settles a failed first read on the one error row naming the reason, raises nothing, then renders rows when a value lands', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const reporter = recordingReporter();
    const { tree } = makeTree([], { instance, reporter });

    const pending = tree.getChildren();
    instance.fail('EISDIR: illegal operation on a directory, read plugins.txt');
    const rows = await within(pending, 500);

    expect(rows).toHaveLength(1);
    const error = expectInstanceOf(rows[0], ErrorNode);
    expect(error.label).toBe('Failed to load: EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.tooltip).toBe('EISDIR: illegal operation on a directory, read plugins.txt');
    expect(error.iconPath).toEqual(new ThemeIcon('error'));
    expect(reporter.reports).toEqual([]);

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const after = await within(tree.getChildren(), 500);

    expect(after.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp']);
    expect(reporter.reports).toEqual([]);
  });

  // A genuinely empty plugins.txt (sequence already past 0) is not "not read yet" — it must
  // still render EmptyNode honestly, not hang waiting for a value that already landed.
  it('renders EmptyNode immediately when the first landed value is genuinely empty', async () => {
    const { tree } = makeTree([], { instance: new FakeInstance(valueOf([]), 1) });
    const rows = await tree.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
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

  it('returns an empty list (not the "No plugins" node) when the filter matches nothing', async () => {
    const { tree } = makeTree([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]);
    tree.setFilter('nomatch');
    const rows = await tree.getChildren();

    expect(rows).toEqual([]);
    expect(rows.some((r) => r instanceof EmptyNode)).toBe(false);
  });

  // The filter outlives a Refresh and whatever the re-pulled value turns up: invalidate() clears
  // the row cache and must not touch the term.
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

  // A filter keystroke must re-render already-built rows, never rebuild them from the Instance
  // value.
  it('does not rebuild rows (render-only, not invalidate)', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren(); // populates the cache off the value above

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]); // no publish(), no invalidate()
    tree.setFilter('a');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']); // the stale cache
  });

  it('clearing the filter restores all cached rows, without rebuilding', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const { tree } = makeTree([], { instance });
    await tree.getChildren();
    tree.setFilter('alpha');
    await tree.getChildren();

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]); // no publish(), no invalidate()
    tree.setFilter('');
    const rows = await tree.getChildren();

    expect(rows.map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });
});

// ── drag and drop ────────────────────────────────────────────────────────────

const NONE = new FakeCancellationToken(); // the drag/drop methods ignore the token

// handleDrag's own payload shape, read back the same way handleDrop reads it (isDropPayload).
function namesFrom(item: unknown): string[] {
  const { value } = expectInstanceOf(item, DataTransferItem);
  if (!isDropPayload(value)) throw new Error('Expected a names payload');
  return value.names;
}

describe('PluginsTreeProvider — drag-and-drop reorder', () => {
  const ORDER = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const fixturePlugins = (names: string[] = ORDER) => names.map((name, slot) => plugin({ name, slot }));
  const node = (name: string) => new PluginNode({ name, enabled: true });

  async function drag(source: FakeSource, moved: string[], target: string | undefined, names: string[] = ORDER) {
    const reporter = recordingReporter();
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins(names))),
      source,
      reporter,
    });
    await tree.getChildren(); // populate the cached order
    let fired = false;
    tree.onDidChangeTreeData(() => { fired = true; });

    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, NONE);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, NONE);
    return { reports: reporter.reports, fired };
  }

  it('handleDrag serialises the whole selection, not just the grabbed row', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp'), node('C.esp')], dt, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(namesFrom(item)).toEqual(['A.esp', 'C.esp']);
  });

  it('handleDrag ignores non-plugin nodes (Empty) in the selection', () => {
    const { tree } = makeTree(fixturePlugins());
    const dt = new DataTransfer();
    tree.handleDrag([new EmptyNode(), node('B.esp')], dt, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(namesFrom(item)).toEqual(['B.esp']);
  });

  it('a drop onto a row asks for the block to land before that row', async () => {
    const source = new FakeSource();
    const { fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], drop: { kind: 'before', name: 'D.esp' } }]);
    expect(fired).toBe(true);
  });

  it('drop past the last row (undefined target) asks for the losing end', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp'], undefined);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], drop: { kind: 'losingEnd' } }]);
  });

  it('drop onto a non-plugin node (empty state) asks for the losing end', async () => {
    const source = new FakeSource();
    const { tree } = makeTree([plugin({ name: 'A.esp', slot: 0 })], { source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, NONE);
    await tree.handleDrop(new EmptyNode(), dt, NONE);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], drop: { kind: 'losingEnd' } }]);
  });

  // An implicit master's row sits above every plugins.txt line, so it is the one target that
  // means the winning end rather than a line to land before.
  it('drop onto an implicit master asks for the winning end', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source, implicitMasters: () => Promise.resolve(['Fallout4.esm']) });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('B.esp')], dt, NONE);
    await tree.handleDrop(new ImplicitMasterNode('Fallout4.esm'), dt, NONE);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], drop: { kind: 'winningEnd' } }]);
  });

  it('pluginFileOf names the file a row stands for, and nothing for the empty-state row', () => {
    expect(pluginFileOf(node('A.esp'))).toBe('A.esp');
    expect(pluginFileOf(new ImplicitMasterNode('Fallout4.esm'))).toBe('Fallout4.esm');
    expect(pluginFileOf(new EmptyNode())).toBeUndefined();
  });

  // VS Code can hand this controller a drop target that is not one of its rows. "Not my row" is
  // not "past the last row", which reads as the losing end of the load order.
  it('drop onto a row this tree does not own is refused, not treated as the end of the list', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, NONE);

    await tree.handleDrop(new RecordNode(recordSummary()), dt, NONE);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  // A record row under an expanded plugin is a node of this very tree, so "one of my rows" has
  // to mean a load-order row specifically, not merely something this provider handed out.
  it('drop onto one of this tree own record rows is refused too', async () => {
    const source = new FakeSource();
    const { tree } = makeTree(fixturePlugins(), { source });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, NONE);

    await tree.handleDrop(new RecordTypeNode('A.esp', 'weap', 5, 'Weapon'), dt, NONE);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('contiguous multi-selection moves as one block, named in the drag order', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp', 'C.esp', 'D.esp'], 'A.esp');
    expect(source.reorderPluginsCalls)
      .toEqual([{ names: ['B.esp', 'C.esp', 'D.esp'], drop: { kind: 'before', name: 'A.esp' } }]);
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
    await tree.handleDrop(node('A.esp'), new DataTransfer(), NONE);
    expect(source.reorderPluginsCalls).toEqual([]);
  });

  // A drop position comes from the full plugins.txt order, never the displayed row list: a name
  // filter narrows which rows show, not the load order they belong to (plugins.md).
  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const NAMES = ['M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'];

    const baselineSource = new FakeSource();
    await drag(baselineSource, ['M1.esp'], 'M3.esp', NAMES);

    const filteredSource = new FakeSource();
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins(NAMES))), source: filteredSource,
    });
    await tree.getChildren(); // populate the cached order
    tree.setFilter('m'); // matches M1/M2/M3 only — X1.esp sits hidden between the drag and its target
    const visible = await tree.getChildren();
    expect(visible.map((n) => expectInstanceOf(n, PluginNode).plugin.name)).toEqual(['M1.esp', 'M2.esp', 'M3.esp']);

    const dt = new DataTransfer();
    tree.handleDrag([node('M1.esp')], dt, NONE);
    await tree.handleDrop(node('M3.esp'), dt, NONE);

    expect(filteredSource.reorderPluginsCalls).toEqual(baselineSource.reorderPluginsCalls);
  });

  it('surfaces a write failure via the reporter, naming why, and resyncs the tree (ADR-0019)', async () => {
    const source = new FakeSource();
    source.reorderPluginsError = new Error('disk full');
    const { reports, fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(reports).toEqual([{ severity: 'error', message: 'Failed to reorder plugins.', detail: 'disk full' }]);
    expect(fired).toBe(true); // refresh fired to resync the moved row
  });
});

// End-to-end: the real reorder command over a temp plugins.txt, driven through the provider's
// drag → drop, asserting the on-disk order and byte-faithfulness — independent of the fixture
// value that supplies the rows being dragged.
describe('PluginsTreeProvider — drag reorder round-trips through plugins.txt on disk', () => {
  let dir: string;
  let source: PluginListSource;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const orderOnDisk = async () => parsePlugins(await readFile(pluginsTxt(), 'utf8')).map((e) => e.name);
  const node = (name: string) => new PluginNode({ name, enabled: true });
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
    await tree.getChildren(); // cache the rendered order
    const dt = new DataTransfer();
    tree.handleDrag(moved.map(node), dt, NONE);
    await tree.handleDrop(target === undefined ? undefined : node(target), dt, NONE);
  }

  it('single-row down-drag lands the row before the target and keeps the comment header', async () => {
    await dragToDisk(['A.esp'], 'D.esp');
    // byte-faithful: B stays disabled (no *), A keeps its *, the comment header stays first
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

  // The Plugin load order is Mod Management's own artifact — a disconnected client must not stop
  // the write from reaching disk.
  it('a drag-reorder still writes plugins.txt with the client reporting disconnected', async () => {
    const tree = new PluginsTreeProvider({
      instance: new FakeInstance(valueOf(fixturePlugins())), source, client: makeDisconnectedClient(),
    });
    await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag([node('A.esp')], dt, NONE);

    await tree.handleDrop(node('D.esp'), dt, NONE);

    expect(await readFile(pluginsTxt(), 'utf8')).toBe('# header\r\nB.esp\r\n*C.esp\r\n*A.esp\r\nD.esp\r\nE.esp\r\n');
  });
});

describe('PluginsTreeProvider — resolvePluginPath (Reveal in Explorer)', () => {
  it('resolves a plugin name to the path of its winning plugin', async () => {
    const { tree } = makeTree([
      plugin({ name: 'Base.esp', slot: 0, path: '/data/mods/Winner/Base.esp', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', path: '/data/mods/Loser/Base.esp', winning: false }),
    ]);
    expect(await tree.resolvePluginPath('Base.esp')).toBe('/data/mods/Winner/Base.esp');
  });

  it('returns undefined for a name with no winning plugin', async () => {
    const { tree } = makeTree([plugin({ name: 'Base.esp', slot: 0, winning: false })]);
    expect(await tree.resolvePluginPath('Base.esp')).toBeUndefined();
  });

  it('returns undefined for an unknown name', async () => {
    const { tree } = makeTree([plugin({ name: 'Base.esp', slot: 0 })]);
    expect(await tree.resolvePluginPath('NoSuchPlugin.esp')).toBeUndefined();
  });
});

// Implicit masters render as forced-on rows ahead of plugins.txt lines. The backend names
// them (ADR-0016); this tree only places them.
describe('PluginsTreeProvider — implicit master rows', () => {
  // The Instance adapter's answer, which the tree takes rather than builds.
  const ADAPTER_ANSWER = (name: string) => `/adapter/Data/${name}`;
  // `null` stands for the absence in both slots: a backend that could not answer, and an
  // unresolved Data folder. An explicit `undefined` would select the default instead.
  const treeFor = (
    plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
    implicit: readonly string[] | null = [],
    dataFolderFile: ((name: string) => string | undefined) | null = ADAPTER_ANSWER,
  ) => makeTree(plugins, {
    dataFolderFile: dataFolderFile ?? (() => undefined),
    implicitMasters: () => Promise.resolve(implicit ?? undefined),
  }).tree;

  it('renders the backend names as ImplicitMasterNode rows preceding plugins.txt rows, in the order given, with no checkbox and contextValue pluginImplicit', async () => {
    // The backend answers in load order; the tree preserves it rather than sorting, which would
    // put DLCCoast.esm ahead of the Fallout4.esm it masters.
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

  it('a name the backend calls implicit which plugins.txt also lists renders exactly once, as the implicit row (real LitR CC .esl case)', async () => {
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

  // The rival: treating an unreachable backend as "no implicit masters" here would be harmless,
  // but it must not invent rows either — an unknown answer renders nothing, and the tree still
  // renders every plugins.txt line.
  it('renders no implicit row, and every plugins.txt line, when the backend cannot be reached', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', slot: 0 })], null).getChildren();

    expect(rows.some((r) => r instanceof ImplicitMasterNode)).toBe(false);
    expect(rows.map((r) => r.label)).toEqual(['Mod.esp']);
    expect([...treeFor([], null).lockedRowUris()]).toEqual([]);
  });

  it('renders only implicit rows when plugins.txt is empty, rather than the empty state', async () => {
    const rows = await treeFor([], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('leaves an implicit row without a resourceUri when the Data folder is unresolved', async () => {
    const rows = await treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm'], null).getChildren();
    expect(expectInstanceOf(rows[0], ImplicitMasterNode).resourceUri).toBeUndefined();
  });

  it('handleDrag still filters to only PluginNode rows, excluding implicit rows for free', async () => {
    const tree = treeFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']);
    const rows = await tree.getChildren();
    const dt = new DataTransfer();
    tree.handleDrag(rows, dt, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect(namesFrom(item)).toEqual(['Mod.esp']);
  });
});

// The implicit block has no plugins.txt line, so a drop onto it lands at file-index 0 —
// computed from the fixture slots, never the implicit names.
describe('PluginsTreeProvider — implicit master drop-index mapping', () => {
  let dir: string;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const node = (name: string) => new PluginNode({ name, enabled: true });
  const fixturePlugins = () => [plugin({ name: 'B.esp', slot: 0 }), plugin({ name: 'C.esp', slot: 1 })];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-implicit-drop-'));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n');
    // Raw plugins.txt has NO implicit-master line — Fallout4.esm is purely a synthetic display
    // row; B.esp/C.esp are the real, draggable file rows.
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
    tree.handleDrag(moved.map(node), dt, NONE);
    await tree.handleDrop(target, dt, NONE);
  }

  it('dropping onto the implicit block lands the moved plugin at file-index 0, and the file never gains an implicit-master line', async () => {
    await dragToDisk(['C.esp'], new ImplicitMasterNode('Fallout4.esm'));

    const text = await readFile(pluginsTxt(), 'utf8');
    expect(text).toBe('*C.esp\r\n*B.esp\r\n'); // C moved to file-index 0
    expect(text).not.toContain('Fallout4.esm'); // never written into plugins.txt
  });

  it('dropping onto a normal row is unaffected by the implicit prefix — same file index as with no implicit rows at all', async () => {
    await dragToDisk(['C.esp'], node('B.esp'));
    expect(await readFile(pluginsTxt(), 'utf8')).toBe('*C.esp\r\n*B.esp\r\n');
  });
});

// ── rows are always collapsible; content decides on expand (ADR-0002) ────────

const A_ROW = () => plugin({ name: 'A.esp', slot: 0, origin: 'SomeMod' });
const B_ROW = () => plugin({ name: 'B.esp', slot: 1, origin: 'SomeMod' });

// mEdit is always running (target-architecture.md): a client that answers every call with a
// rejection is what a real disconnect looks like from here (plugins.md, States 3).
function makeDisconnectedClient(): InMemoryMEditClient {
  return disconnect(makeClient());
}

// The adapter's own `disconnected()` clears every scripted answer, record reads included, and
// every subsequent query rejects — the same shape a real disconnected backend's read side takes.
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

  it('keeps the empty-state row a leaf — there is nothing under it to expand', async () => {
    const { tree } = makeTree([]);
    const [empty] = await tree.getChildren();

    expect(empty).toBeInstanceOf(EmptyNode);
    expect(tree.getTreeItem(present(empty, 'the sole child, the empty-state row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
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

  // The rival this guards: collapsibleState quietly reading a held-plugin set again (e.g. `None`
  // while `heldFiles` does not have this row). Nothing the load order ever reports about a plugin
  // reaches this decision any more.
  it('a plugin the load order never reports still gets a chevron', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]); // B.esp is never held
    const rows = await h.tree.getChildren();

    expect(h.tree.getTreeItem(present(rows[1], "B.esp's row")).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });
});

// plugins.md, A row story 5: the game does not load a disabled plugin's records, so there is
// nothing behind the row to expand into — same as an overridden plugin, viewing it is deferred.
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
  // plugins.md, States 2: mEdit not yet up, or the plugin not yet indexed, is "Still indexing…" —
  // never "mEdit is not connected", which promises nothing is coming back.
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

    expect(client.calls).toContainEqual({ method: 'getRecordTypes', args: ['A.esp', undefined] });
    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });

  // A row on an unindexed plugin opening onto an empty list would read as "this plugin has no
  // records" rather than "this plugin isn't indexed yet" (ADR-0019).
  it('a plugin the load order does not hold yet expands to a "still indexing" node', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp')]); // B.esp is never held
    const rows = await h.tree.getChildren();

    expect(await h.tree.getChildren(rows[1])).toEqual([expect.any(IndexingNode)]);
  });

  // A progressive tick lets a landed plugin's row expand into real records before the reconcile
  // completes, and it costs no client read of its own.
  it('applyIndexed lets a landed plugin expand into records, and leaves an un-landed one still indexing', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW(), B_ROW()], { client });
    const rows = await h.tree.getChildren();

    h.tree.applyIndexed(['A.esp'], []);

    expect((await h.tree.getChildren(rows[0]))[0]).toBeInstanceOf(RecordTypeNode);
    expect(await h.tree.getChildren(rows[1])).toEqual([expect.any(IndexingNode)]);
    expect(callCount(h.client, 'getPlugins')).toBe(0);
  });

  // ADR-0013: a PUT that never lands tears nothing down, so the row reports the read that failed.
  // "Still indexing" would promise a completion that is not coming.
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

  it('the empty-state row has no children', async () => {
    const h = makeTree([]);
    await reconcile(h, [held('A.esp')]);
    const [empty] = await h.tree.getChildren();

    expect(await h.tree.getChildren(empty)).toEqual([]);
  });
});

describe('PluginsTreeProvider — reconcile and clear keep row identity, and still fire updates', () => {
  // The rows are the load order the user is looking at, and rebuilding them here would cost them
  // their filter and scroll position for a change that has nothing to do with the disk.
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

  it('pushes the immutable and tracked sets from the reconcile own read', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    const immutable = vi.spyOn(h.records, 'setImmutablePlugins');
    const tracked = vi.spyOn(h.records, 'setTrackedPlugins');

    await reconcile(h, [held('A.esp', { isImmutable: true }), held('B.esp', { isTracked: true })]);

    expect(immutable).toHaveBeenCalledWith([{ name: 'A.esp', origin: 'SomeMod' }]);
    expect(tracked).toHaveBeenCalledWith([{ name: 'B.esp', origin: 'SomeMod' }]);
  });

  // ADR-0012 invariant 1: two plugins that share a filename are never one plugin.
  it("never marks a plugin's records read-only or tracked for another plugin of the same name", async () => {
    const client = makeClient({
      recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }],
      records: { items: [recordSummary({ plugin: 'Shared.esp', formKey: '000001:Shared.esp', origin: 'ModB' })], total: 1 },
    });
    const h = makeTree([plugin({ name: 'Shared.esp', slot: 0, origin: 'ModB' })], { client });
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', isImmutable: true, isTracked: true }),
      held('Shared.esp', { origin: 'ModB' }),
    ]);

    const [row] = await h.tree.getChildren();
    const [group] = await h.tree.getChildren(present(row, 'the Shared.esp row'));
    const [record] = await h.tree.getChildren(present(group, 'the Weapon group'));

    expect(expectInstanceOf(record, RecordNode).contextValue).toBe('recordUntracked');
  });
});

// ADR-0002: mEdit is always running, so a disconnect is an error the tree surfaces, not a mode
// (target-architecture.md).
describe('PluginsTreeProvider with the client reporting disconnected', () => {
  // Guards against the vacuous form of every test below: this actually drives the reconcile
  // against a client wired to fail, and checks the failure was observed, before trusting any
  // node it renders.
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

  it('renders no backend-derived badge on any row', async () => {
    const h = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await h.tree.applyReconciled([]);
    const [row] = await h.tree.getChildren();

    const item = h.tree.getTreeItem(present(row, 'the sole row'));
    // The base tooltip (file name, mod) is the row's own identity, not a backend fact.
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.description).toBeUndefined();
    expect(item.iconPath).toBeUndefined();
  });

  // Collapsing "disconnected" and "still indexing" into the same node would leave a user unable
  // to tell "wait" from "broken".
  it('is distinguishable from a "still indexing" row', async () => {
    const disconnected = makeTree([A_ROW()], { client: makeDisconnectedClient() });
    await disconnected.tree.applyReconciled([]);
    const [discRow] = await disconnected.tree.getChildren();
    const [discChild] = await disconnected.tree.getChildren(discRow);

    const indexing = makeTree([A_ROW(), B_ROW()]);
    indexing.tree.applyIndexed(['A.esp'], []); // B.esp is not indexed yet
    const rows = await indexing.tree.getChildren();
    const [idxChild] = await indexing.tree.getChildren(rows[1]);

    expect(discChild).toBeInstanceOf(ErrorNode);
    expect(idxChild).toBeInstanceOf(IndexingNode);
    expect(expectInstanceOf(discChild, ErrorNode).label).not.toBe(expectInstanceOf(idxChild, IndexingNode).label);
  });
});

// plugins.md, States 4; ADR-0009 point 5: `heldElsewhere` overrides every row; `failed` only a
// row this reload never reached, held rows staying browsable.
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

  // The rival this guards: a Failed refusal treated the same as heldElsewhere, blanking an
  // already-held row's records too.
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
    await reconcile(h, [held('A.esp')]); // B.esp is never held
    const rows = await h.tree.getChildren();

    h.tree.applyRefused(failed);
    const children = await h.tree.getChildren(rows[1]);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe(failed.message);
  });

  it('leaves the row set and each row\'s status alone — the tree does not change shape', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp', { masterIssues: [{ kind: 'DirectlyMissing', masterName: 'C.esp' }] })]);
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

    h.tree.applyIndexed(['A.esp'], []);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });
});

// plugins.md, States 3: mEdit confirmed unreachable — the same Disconnected/Stopped the status
// bar reads (ADR-0002 invariant 2), wired in directly rather than inferred from a failed read.
describe('PluginsTreeProvider — applyBackendUnreachable', () => {
  it('names the reason on a row, before any reconcile has landed', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected — start MEditService and reload.');
    const children = await h.tree.getChildren(row);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('mEdit is disconnected — start MEditService and reload.');
  });

  // The rival this guards: a disconnect mid-reconcile leaving an unheld row "Still indexing…"
  // forever, because `heldFiles` is already a (partial) Set rather than undefined.
  it('names the reason on a row this reload has not reached yet, mid-reconcile', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    h.tree.applyIndexed(['A.esp'], []); // B.esp is mid-reconcile, not yet reached
    const rows = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected — start MEditService and reload.');
    const children = await h.tree.getChildren(rows[1]);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('mEdit is disconnected — start MEditService and reload.');
  });

  it('leaves an already-held row browsable — the disconnect is not this row\'s to report', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 1, displayName: 'Weapon' }] });
    const h = makeTree([A_ROW()], { client });
    h.tree.applyIndexed(['A.esp'], []);
    const [row] = await h.tree.getChildren();

    h.tree.applyBackendUnreachable('mEdit is disconnected — start MEditService and reload.');
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(RecordTypeNode);
  });

  it('clears once a later tick lands, resuming "Still indexing…"', async () => {
    const h = makeTree([A_ROW()]);
    h.tree.applyBackendUnreachable('mEdit is disconnected — start MEditService and reload.');

    h.tree.applyIndexed([], []);
    const [row] = await h.tree.getChildren();
    const children = await h.tree.getChildren(row);

    expect(children[0]).toBeInstanceOf(IndexingNode);
  });

  // The rival this guards: a disconnect signal overwriting a stronger heldElsewhere refusal,
  // letting a reconnect quietly un-block rows a second window still holds.
  it('never downgrades an everyRow refusal already in force', async () => {
    const h = makeTree([A_ROW()]);
    const [row] = await h.tree.getChildren();
    h.tree.applyRefused({ kind: 'heldElsewhere', message: 'another Modbench window holds this instance' });

    h.tree.applyBackendUnreachable('mEdit is disconnected — start MEditService and reload.');
    const children = await h.tree.getChildren(row);

    expect(expectInstanceOf(children[0], ErrorNode).tooltip).toBe('another Modbench window holds this instance');
  });
});

// ── the record filter hides a plugin with no matches (plugins.md) ──────

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

  // Nothing fetched has to read the same as "no filter active".
  it('keeps every row present and expandable before any answer has landed', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);

    const rows = await h.tree.getChildren();
    expect(rows).toHaveLength(1);
    expect(h.tree.getTreeItem(present(rows[0], 'the sole row')).collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
  });

  // The empty-state row stands for no plugin file, so a record filter has nothing to have an
  // opinion about and it is never a candidate for hiding.
  it('never hides the empty-state row', async () => {
    const h = makeTree([]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  // An implicit master has no mod origin to join facts on, so its filter match falls back to
  // its name alone (ADR-0012) — it is as filterable as any other row, not exempt.
  it('hides an implicit master row the record filter matches no records of', async () => {
    const h = makeTree([], { implicitMasters: () => Promise.resolve(['Fallout4.esm']) });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data', hasMatchingRecords: false })]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  it('restores a hidden plugin immediately, in load order, once the filter clears', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false }), held('B.esp')]);
    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['B.esp']);

    // Stands in for clearFilter's real hand-off: refreshMatchingPlugins re-reads the facts.
    h.client.setQueryAnswer('getPlugins', [held('A.esp'), held('B.esp')]);
    await h.tree.refreshFacts();

    expect((await h.tree.getChildren()).map((r) => expectInstanceOf(r, PluginNode).label)).toEqual(['A.esp', 'B.esp']);
  });

  // A reorder made while a row is hidden lands in its new position once the filter clears:
  // nothing here caches the visible order.
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

  // The hide decision reads `hasMatchingRecords` alone — never a master issue or a load
  // failure — so a plugin carrying either is hidden right along with an ordinary one.
  it('hides a plugin with a missing-master flag while the filter matches none of its records', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      hasMatchingRecords: false,
      masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
    })]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  it('hides a plugin that failed to load while the filter matches none of its records', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);

    expect(await h.tree.getChildren()).toEqual([]);
  });

  // Briefly over-showing rows beats freezing every one behind an answer that cannot be checked,
  // so a failed re-read forgets which plugins matched.
  it('shows every row again when the fact re-read fails', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { hasMatchingRecords: false })]);
    expect(await h.tree.getChildren()).toEqual([]);

    h.client.setQueryFailure('getPlugins', new Error('GET /plugins failed (503)'));
    expect(await h.tree.refreshFacts()).toBeUndefined();

    expect(await h.tree.getChildren()).toHaveLength(1);
  });

  // plugins.md, A row: "no blink" — a row the record filter hides stays hidden across a reload
  // tick, until the new reconcile's own answer says otherwise.
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

  // A stale answer must lose to a newer request sharing its in-flight window.
  it('a filter set while the client is answering, then cleared, leaves no stale hidden row', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp')]);
    expect(await h.tree.getChildren()).toHaveLength(1);

    let resolveSlow!: (plugins: PluginMetadata[]) => void;
    const slow = new Promise<PluginMetadata[]>((resolve) => { resolveSlow = resolve; });
    // The first call answers with the still-pending `slow`; every call after falls through to
    // the fixed answer below, once the queued step is drained.
    h.client.setQueryAnswerOnce('getPlugins', slow);
    h.client.setQueryAnswer('getPlugins', [held('A.esp')]);

    // Setting the filter starts a fact re-read the backend is slow to answer.
    const filterSet = h.tree.refreshFacts();
    // The filter clears before that answer lands: a second re-read starts and resolves first.
    await h.tree.refreshFacts();
    expect(await h.tree.getChildren()).toHaveLength(1);

    // The slow, now-stale "filtered" answer lands last.
    resolveSlow([held('A.esp', { hasMatchingRecords: false })]);
    await filterSet;

    expect(await h.tree.getChildren()).toHaveLength(1);
  });
});

// ── children ─────────────────────────────────────────────────────────────────

describe('PluginsTreeProvider — a row expands into the record browser children', () => {
  const withRecords = (client: InMemoryMEditClient) => makeTree([A_ROW()], { client });

  it('asks the record browser for that plugin children, by filename', async () => {
    const client = makeClient({ recordTypes: [{ type: 'weap', count: 5, displayName: 'Weapon' }] });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const children = await h.tree.getChildren(row);

    expect(client.calls).toContainEqual({ method: 'getRecordTypes', args: ['A.esp', undefined] });
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(RecordTypeNode);
    expect(expectInstanceOf(children[0], RecordTypeNode).label).toBe('Weapon');
    expect(expectInstanceOf(children[0], RecordTypeNode).description).toBe('5');
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
    expect(expectInstanceOf(records[0], RecordNode).label).toBe('TheWeapon [000001:A.esp]');
  });

  it('renders the worldspace and cell hierarchy under a row', async () => {
    const client = makeClient({
      recordTypes: [{ type: 'wrld', count: 1, displayName: 'Worldspace' }],
      worldspaces: [{ formKey: 'w:A.esp', editorId: 'Commonwealth', hasParseFailure: false }],
      worldspaceBlocks: {
        topCells: [],
        blocks: [{
          x: 0, y: 0, hasParseFailure: false,
          subBlocks: [{
            x: 1, y: 1, hasParseFailure: false,
            cells: [{ formKey: 'c:A.esp', editorId: 'TheCell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasParseFailure: false }],
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
    expect(expectInstanceOf(cell, CellNode).label).toBe('< 12,  -5>');
  });

  it('pages the interior cells, with a load-more leaf carrying the remainder', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      formKey: `i${i}:A.esp`, editorId: `IntCell${i}`, cellX: i, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false,
    }));
    const client = makeClient({
      recordTypes: [{ type: 'cell', count: 120, displayName: 'Cell' }],
      interiorCells: { items, total: 120 },
    });
    const h = withRecords(client);
    await reconcile(h, [held('A.esp')]);
    const [row] = await h.tree.getChildren();

    const [interior] = await h.tree.getChildren(row);
    expect(interior).toBeInstanceOf(InteriorCellsNode);
    const cells = await h.tree.getChildren(interior);

    expect(cells).toHaveLength(51);
    expect(cells[50]).toBeInstanceOf(InteriorLoadMoreNode);
    expect(expectInstanceOf(cells[50], InteriorLoadMoreNode).label).toBe('$(sync) Load more… (70 remaining)');
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

  // The record browser answers a failed fetch with an error node (ADR-0019) — the merged tree
  // must not turn that into an empty list on its way through.
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

  it('forwards the record browser targeted change events, so a load-more refreshes one parent', async () => {
    const h = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    h.tree.onDidChangeTreeData((e) => fired.push(e));
    const parent = new InteriorCellsNode('A.esp');

    await h.records.loadMore(new InteriorLoadMoreNode(parent, 10));

    expect(fired).toContain(parent);
  });

  it('forwards the load order own change events', () => {
    const { tree } = makeTree([A_ROW()]);
    const fired: unknown[] = [];
    tree.onDidChangeTreeData((e) => fired.push(e));

    tree.invalidate();

    expect(fired).toEqual([undefined]);
  });
});

// ── decorations ──────────────────────────────────────────────────────────────

async function rowItem(h: Harness, index = 0): Promise<vscode.TreeItem> {
  const rows = await h.tree.getChildren();
  return h.tree.getTreeItem(present(rows[index], `row at index ${index}`));
}

// `TreeItem.tooltip` is `string | MarkdownString | undefined` — every row here sets a plain
// string, so a test reading it back narrows through this instead of an `as`.
function expectString(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`Expected a string, got ${String(value)}`);
  return value;
}

// ADR-0017: read-only-for-editing is never an icon; it is the absent actions and this note.
// plugins.md, A row: the tooltip always carries the file name and the mod, whatever else it says.
describe('PluginsTreeProvider — read-only tooltip', () => {
  it('carries the base tooltip, with no read-only line, before a load order exists', async () => {
    const h = makeTree([A_ROW()]);

    const tooltip = expectString((await rowItem(h)).tooltip);
    expect(tooltip).toBe('A.esp\nSomeMod');
  });

  it('tags a read-only plugin tooltip once the load order says so', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isImmutable: true })]);

    expect((await rowItem(h)).tooltip).toContain('read-only');
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

  it('omits the mod line, rather than leaving a blank one, when the row carries no origin', () => {
    const h = makeTree([A_ROW()]);
    const node = new PluginNode({ name: 'X.esp', enabled: true });

    expect(h.tree.getTreeItem(node).tooltip).toBe('X.esp');
  });

  // plugins.md, A row: "no blink" — the last statuses, read-only included, stay until the new
  // reconcile's own answer lands.
  it('stays through a fresh load start, until a new reconcile answers', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { isImmutable: true })]);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    h.tree.applyIndexed([], []);
    expect((await rowItem(h)).tooltip).toContain('read-only');

    await reconcile(h, [held('A.esp')]);
    expect((await rowItem(h)).tooltip).not.toContain('read-only');
  });

  // plugins.md, A plugin the game loads with no line: the locked row's tooltip is MO2's one
  // sentence alone — no file name, no mod, no read-only line, whatever the backend answers.
  it('never adds a read-only line to the locked row — its tooltip is the one sentence alone', async () => {
    const h = makeTree([], { implicitMasters: () => Promise.resolve(['Fallout4.esm']) });
    await reconcile(h, [held('Fallout4.esm', { origin: 'Data', isImmutable: true })]);

    expect((await rowItem(h)).tooltip).toBe(
      "This plugin can't be disabled or moved (enforced by the game).");
  });
});

// ADR-0017: a plugin declaring a master absent from the load order is flagged and stays fully
// browsable — never deactivated, excluded or hidden.
describe('PluginsTreeProvider — master-issue decoration (ADR-0017 AC1/AC2/AC4)', () => {
  const withIssues = (h: Harness, issues: { masterName: string; kind: 'DirectlyMissing' | 'Unloadable' }[]) =>
    reconcile(h, [held('A.esp', { masterIssues: issues })]);

  it('flags a row with a directly-missing master', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }]);

    const item = await rowItem(h);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    // The same red the Problems panel uses, not the plain foreground color a colorless
    // ThemeIcon renders in — otherwise indistinguishable at a glance in a large load order.
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
  });

  it('flags a row whose master is itself unloadable, worded distinctly from directly-missing', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, [{ masterName: 'Broken.esm', kind: 'Unloadable' }]);

    const tooltip = expectString((await rowItem(h)).tooltip);
    expect(tooltip).toContain('Master Broken.esm cannot be loaded');
    expect(tooltip).not.toContain('Missing master');
  });

  it('matches the plugin key case-insensitively, like the load order set itself', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.ESP', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }] })]);

    expect((await rowItem(h)).tooltip).toContain('Missing master');
  });

  // Never deactivated, excluded or hidden. The leading slot (checkbox) and the row's
  // expandability are both untouched by this decoration.
  it('never touches collapsibleState — AC2, and the leading slot stays the checkbox alone', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }]);

    const item = await rowItem(h);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    expect(item.checkboxState).toBe(vscode.TreeItemCheckboxState.Checked);
  });

  it('leaves an unaffected plugin row undecorated', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [
      held('A.esp', { masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }] }),
      held('B.esp'),
    ]);

    const item = await rowItem(h, 1);
    expect(item.tooltip).toBe('B.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });

  // This decoration touches icon and description as well as tooltip, so a reused row must
  // restore all three, not just the tooltip.
  it('clears icon, description and tooltip once the master resolves (reused-row hazard)', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }]);
    expect((await rowItem(h)).tooltip).toContain('Missing master');

    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
    expect(item.description).toBeUndefined();
  });

  // The wire type is `masterIssues?: MasterIssue[] | null`, so a response lacking it degrades to
  // "no issues" rather than throwing; PluginMetadata cannot express that shape, so the fixture
  // bypasses the type at the call site.
  it('degrades to undecorated, without throwing, when a plugin issue list is absent', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', { masterIssues: undefined })]);

    const item = await rowItem(h);
    expect(item.tooltip).toBe('A.esp\nSomeMod');
    expect(item.iconPath).toBeUndefined();
  });

  it('renders the backend wording for each flagged master, once, with a count', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, [
      { masterName: 'Ghost.esm', kind: 'DirectlyMissing' },
      { masterName: 'Broken.esm', kind: 'Unloadable' },
    ]);

    const item = await rowItem(h);
    expect(item.description).toBe('2 master issues');
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
    expect(item.tooltip).toContain('Master Broken.esm cannot be loaded');
  });

  it('leaves a row the backend flags nothing on undecorated', async () => {
    const h = makeTree([A_ROW()]);
    await withIssues(h, []);

    expect((await rowItem(h)).tooltip).toBe('A.esp\nSomeMod');
  });
});

// ADR-0017: a plugin that fails to open or parse still has a row — rows come from plugins.txt,
// not from the load order — so this decorates an existing row with its recorded reason.
describe('PluginsTreeProvider — load-failure decoration (ADR-0017 AC7)', () => {
  it('flags a row whose plugin failed to load, with the reason', async () => {
    const h = makeTree([A_ROW()]);
    // The reason can be a multi-line exception-chain summary (LoadOrder.PluginLoadFailure
    // joins outer through innermost message) — the tooltip must carry every line, readably.
    const reason = 'InvalidOperationException: Malformed record\nFormatException: bad subrecord at offset 12';
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason }]);

    const item = await rowItem(h);
    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('failed to load');
    expect(item.tooltip).toContain('Failed to load: InvalidOperationException: Malformed record');
    expect(item.tooltip).toContain('FormatException: bad subrecord at offset 12');
  });

  // A plugin the load order gave up on is never reached by a later tick, so "still indexing"
  // would promise a completion that never comes (ADR-0019) — it answers the error node instead.
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

    expect((await rowItem(h)).tooltip).toContain('Failed to load');
  });

  // plugins.md, States 2: a plugin not yet reached in a fresh reload reads "still indexing",
  // never an error — even one that failed in the reconcile before this one started.
  it('keeps the failed-to-load status (no blink) while expansion still reads "still indexing" for an unreached plugin', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);
    expect((await rowItem(h)).description).toBe('failed to load');

    // A fresh reload begins; this tick has not reached A.esp yet.
    h.tree.applyIndexed([], []);

    expect((await rowItem(h)).description).toBe('failed to load');
    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('clears the failed tooltip once a later reconcile reports the plugin loaded', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [], [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }]);
    expect((await rowItem(h)).tooltip).toContain('Failed to load');

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

// A plugin that loaded but holds a record Mutagen could not read carries the same failure prefix
// as a failed plugin, from the fact the plugin listing already answers.
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

// The malformed-plugin diagnoses join the same decoration chain at warning tier, below a load
// failure or master issue, since a malformed plugin still loads and plays.
describe('PluginsTreeProvider — malformed-plugin diagnosis decoration', () => {
  const REGN = 'REGN 001D2AF4 (DowntownRegion) — fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8';

  it('decorates a diagnosed plugin row with the warning badge and the diagnosis text', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.ESP', REGN)]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.description).toBe('malformed');
    expect(item.tooltip).toContain('RDAT is 6 bytes');
  });

  // plugins.md, A row: the Words column has one fixed word, "malformed" — no count variant,
  // unlike master issues. The tooltip line still carries every diagnosis.
  it('two diagnoses on one plugin read as the same fixed word, with both in the tooltip line', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'first diagnosis'), diagnosis('A.esp', 'second diagnosis')]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(item.description).toBe('malformed');
    expect(item.tooltip).toContain('first diagnosis');
    expect(item.tooltip).toContain('second diagnosis');
  });

  // plugins.md, A row: "no blink".
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

    // A different answer than the one already showing: only a landed scan can produce this.
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

  // One derivation, two surfaces: the Problems panel gets the same reports the badge does.
  it('publishes the scan for the Problems panel as well as the row badge', async () => {
    const published: PluginDiagnosisReport[][] = [];
    const h = makeTree([A_ROW()], { publishDiagnoses: (reports) => published.push(reports) });
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);

    await reconcile(h, [held('A.esp')]);

    expect(published).toEqual([[diagnosis('A.esp', 'some diagnosis')]]);
  });
});

// plugins.md, A row: every status a plugin carries shows at once. The first in spec order sets
// the icon; the description carries every status's words, the tooltip a line for each.
describe('PluginsTreeProvider — several statuses on one row', () => {
  it('shows all four statuses: the first status\'s icon, every status\'s words, one tooltip line each', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(
      h,
      [held('A.esp', { hasParseFailure: true, masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }] })],
      [{ name: 'A.esp', origin: 'SomeMod', reason: 'Malformed record' }],
    );

    const item = await rowItem(h);
    // Failed to load is first in spec order, so it sets the icon — error tier, not the
    // Malformed status's warning tier.
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('failed to load, 1 master issue, unreadable records, malformed');
    const tooltip = expectString(item.tooltip);
    expect(tooltip).toContain('Failed to load: Malformed record');
    expect(tooltip).toContain('Missing master: Ghost.esm');
    expect(tooltip).toContain('could not be read');
    expect(tooltip).toContain('some diagnosis');
  });

  it('sets the icon from the first present status, skipping ones this row does not carry', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      hasParseFailure: true,
      masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
    })]);

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsErrorIcon.foreground'));
    expect(item.description).toBe('1 master issue, unreadable records');
  });

  // Malformed is last in spec order and warning tier: its icon shows only when it stands alone.
  it('uses the warning icon only when Malformed is the sole status present', async () => {
    const h = makeTree([A_ROW()]);
    h.client.setQueryAnswer('getDiagnoses', [diagnosis('A.esp', 'some diagnosis')]);
    await reconcile(h, [held('A.esp')]);

    const item = await rowItem(h);
    expect(expectInstanceOf(item.iconPath, ThemeIcon).color).toEqual(new vscode.ThemeColor('problemsWarningIcon.foreground'));
    expect(item.description).toBe('malformed');
  });

  // The read-only line is independent of status, alongside whatever statuses the row carries.
  it('carries the read-only line alongside a status', async () => {
    const h = makeTree([A_ROW()]);
    await reconcile(h, [held('A.esp', {
      isImmutable: true,
      masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
    })]);

    const item = await rowItem(h);
    expect(item.description).toBe('1 master issue');
    expect(item.tooltip).toContain('read-only');
    expect(item.tooltip).toContain('Missing master: Ghost.esm');
  });
});

// A change to which file a plugin name resolves to is absorbed by the reconcile verb (ADR-0013),
// so `contextValue: 'plugin'` is the only value a healthy row carries.
describe('PluginsTreeProvider applies no decoration of its own to a healthy plugin row', () => {
  it('renders every plugin row plainly, whatever the load order state', async () => {
    const h = makeTree([A_ROW(), B_ROW()]);
    await reconcile(h, [held('A.esp'), held('B.esp')]);

    const names = ['A.esp', 'B.esp'];
    for (const index of [0, 1]) {
      const item = await rowItem(h, index);
      expect(item.contextValue).toBe('plugin');
      expect(item.description).toBeUndefined();
      expect(item.tooltip).toBe(`${names[index]}\nSomeMod`);
    }
  });
});

// A fact re-read alters no line of the load order, so the rows are the same rows — re-decorated,
// never rebuilt. Wiring it to `invalidate()` breaks that.
describe('PluginsTreeProvider fact refresh', () => {
  it('re-renders without rebuilding the rows', async () => {
    const h = makeTree([A_ROW()]);
    const before = await h.tree.getChildren();
    const heard: unknown[] = [];
    h.tree.onDidChangeTreeData(() => heard.push(true));

    await h.tree.refreshFacts();

    expect(heard).toHaveLength(1);
    // Re-rendering hands back the rows already built, so a row keeps its identity — which is what
    // the decoration state (and the tree's selection) is keyed to.
    expect((await h.tree.getChildren())[0]).toBe(before[0]);
  });
});

// ── the origin join (ADR-0012) ───────────────────────────────────────────────

// Two held plugins can share a filename (ADR-0013), so a name-only join answers about whichever
// plugin the reply lists last. Every fixture below lists the row's own plugin first.
describe('PluginsTreeProvider — a name under two origins joins to the row own origin', () => {
  const SHARED_ROW = () => plugin({ name: 'Shared.esp', slot: 0, origin: 'ModA' });

  it('badges the row from its own plugin master issues, not the other plugin', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'ModA', masterIssues: [{ masterName: 'AMaster.esm', kind: 'DirectlyMissing' }] }),
      held('Shared.esp', { origin: 'ModB', masterIssues: [{ masterName: 'BMaster.esm', kind: 'DirectlyMissing' }] }),
    ]);

    const tooltip = expectString((await rowItem(h)).tooltip);
    expect(tooltip).toContain('Missing master: AMaster.esm');
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

  // A load failure names the plugin that failed. The overridden plugin is not a row (rows are the
  // winning plugin of every plugins.txt line), so its failure lands on no row rather than on the
  // plugin that loaded.
  it('leaves the winning row clean when the other plugin is the one that failed to load', async () => {
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

  it('expands the winning row as still indexing, never into the other plugin failure', async () => {
    const h = makeTree([SHARED_ROW()]);
    h.tree.applyIndexed([], [{ name: 'Shared.esp', origin: 'ModB', reason: 'Malformed record' }]);

    const [row] = await h.tree.getChildren();
    expect(await h.tree.getChildren(row)).toEqual([expect.any(IndexingNode)]);
  });

  it('flags the row when its own plugin failed to load and the other plugin loaded', async () => {
    const h = makeTree([SHARED_ROW()]);
    await reconcile(h, [held('Shared.esp', { origin: 'ModB' })],
      [{ name: 'Shared.esp', origin: 'ModA', reason: 'Malformed record' }]);

    expect((await rowItem(h)).description).toBe('failed to load');
  });

  it('joins case-insensitively on the origin as well as the name', async () => {
    const h = makeTree([plugin({ name: 'Shared.esp', slot: 0, origin: 'MODA' })]);
    await reconcile(h, [
      held('Shared.esp', { origin: 'moda', masterIssues: [{ masterName: 'AMaster.esm', kind: 'DirectlyMissing' }] }),
      held('Shared.esp', { origin: 'ModB' }),
    ]);

    expect((await rowItem(h)).tooltip).toContain('AMaster.esm');
  });

  it('falls back to the name alone when the row origin matches no plugin the answer names', async () => {
    const h = makeTree([plugin({ name: 'A.esp', slot: 0, origin: 'RenamedMod' })]);
    await reconcile(h, [held('A.esp', {
      origin: 'SomeOtherMod', masterIssues: [{ masterName: 'Ghost.esm', kind: 'DirectlyMissing' }],
    })]);

    expect((await rowItem(h)).tooltip).toContain('Missing master: Ghost.esm');
  });
});

// ── one read per reconcile ───────────────────────────────────────────────────

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

  // ADR-0019: a failed read is an error and a failed background scan is a warning, so the two
  // cannot arrive at the same channel level.
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

  // A slow read answering after a newer load started would resurrect the load order it replaced.
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
