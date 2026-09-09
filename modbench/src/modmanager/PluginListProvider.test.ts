import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reorderPlugins } from './commands/plugins';
import { parsePlugins } from './mo2/pluginsText';
import type { LoadOrderPlugin, LoadOrderPluginLine } from './loadOrderSnapshot';
import type { InstanceValue } from './instance';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  uriFilePlain, DataTransferItem, DataTransfer,
} from '../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  Uri: { file: uriFilePlain }, DataTransferItem, DataTransfer,
}));

import {
  PluginListProvider, PluginNode, ImplicitMasterNode, EmptyNode, pluginFileOf,
  type PluginListSource,
} from './PluginListProvider';
import { ErrorNode } from './ErrorNode';

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

// Only `.plugins` is ever read by the row provider — the rest of InstanceValue is Mods-tree/
// Editing territory this ticket does not touch.
function valueOf(plugins: (LoadOrderPlugin | LoadOrderPluginLine)[]): InstanceValue {
  return { plugins } as unknown as InstanceValue;
}

// The double the row provider's own contract needs: `.value` plus `.subscribe`, structurally
// compatible with `Instance` without ever constructing one (ADR-0047's watchers are Instance's
// concern, not this provider's).
class FakeInstance {
  value: InstanceValue;
  // Defaults to 1 ("already loaded") so every existing fixture-based test needs no opinion on
  // it; a test of the sequence === 0 ("not read yet") guard passes 0 explicitly.
  sequence: number;
  private subscribers: ((value: InstanceValue, sequence: number) => void)[] = [];
  constructor(initial: InstanceValue, sequence = 1) {
    this.value = initial;
    this.sequence = sequence;
  }
  subscribe(subscriber: (value: InstanceValue, sequence: number) => void) {
    this.subscribers.push(subscriber);
    return { dispose: () => { this.subscribers = this.subscribers.filter((s) => s !== subscriber); } };
  }
  // Simulates a landed recompute: publishes to every live subscriber, the way Instance's own
  // watcher-driven recompute does.
  publish(value: InstanceValue): void {
    this.value = value;
    this.sequence++;
    for (const subscriber of [...this.subscribers]) subscriber(value, this.sequence);
  }
}

class FakeSource implements PluginListSource {
  setPluginEnabledCalls: { pluginName: string; enabled: boolean }[] = [];
  reorderPluginsCalls: { names: string[]; toIndex: number }[] = [];
  reorderPluginsError?: Error;
  setPluginEnabled(pluginName: string, enabled: boolean): Promise<void> {
    this.setPluginEnabledCalls.push({ pluginName, enabled });
    return Promise.resolve();
  }
  reorderPlugins(names: string[], toIndex: number): Promise<void> {
    if (this.reorderPluginsError) return Promise.reject(this.reorderPluginsError);
    this.reorderPluginsCalls.push({ names, toIndex });
    return Promise.resolve();
  }
}

// What the composition root binds: the reorder command against one instance root and profile.
const writesTo = (instanceRoot: string): PluginListSource => ({
  setPluginEnabled: () => Promise.reject(new Error('not exercised by the drag tests')),
  reorderPlugins: async (names, toIndex) => {
    const result = await reorderPlugins(instanceRoot, 'Default', names, toIndex);
    if (!result.applied) throw new Error(result.refusal);
  },
});

const makeProvider = (
  plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
  extra: Partial<{
    source: PluginListSource;
    instance: FakeInstance;
    dataFolder: () => Promise<string | undefined>;
    implicitMasters: () => Promise<readonly string[] | undefined>;
  }> = {},
) => {
  const instance = extra.instance ?? new FakeInstance(valueOf(plugins));
  const source = extra.source ?? new FakeSource();
  return new PluginListProvider({
    instance, source, dataFolder: extra.dataFolder, implicitMasters: extra.implicitMasters,
  });
};

// The leading slot answers one question: can you change whether this loads? A lock fills it
// where a togglable row renders a checkbox, since the platform has no non-interactive checkbox
// variant.
describe('ImplicitMasterNode — leading slot', () => {
  it('renders a lock icon, not a checkbox', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.iconPath).toEqual({ id: 'lock' });
    expect(node.checkboxState).toBeUndefined();
  });

  it('tooltip explains why, in MO2\'s own wording', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.tooltip).toContain('Fallout4.esm');
    expect(node.tooltip).toContain("can't be disabled or moved (enforced by the game)");
  });

  it('sets resourceUri from the given path, for the label-graying decoration provider to key on', () => {
    const node = new ImplicitMasterNode('Fallout4.esm', '/game/Data/Fallout4.esm');
    expect(node.resourceUri).toEqual({ fsPath: '/game/Data/Fallout4.esm' });
  });

  it('leaves resourceUri undefined when no path is given (test-construction convenience)', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.resourceUri).toBeUndefined();
  });
});

// xEdit parity: selecting a plugin node shows its File Header, with no separate affordance.
// Routed through the modbench.openHeader bridge command, because this file is forbidden
// Editing's vocabulary and the composition root owns that translation.
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

// ErrorNode is shared with ModListProvider (./ErrorNode.ts); this provider never constructs
// one, but its checkbox/lock absence is worth guarding here too, alongside EmptyNode's, as
// both are "rows outside the load order".
describe('leading slot — rows outside the load order render neither checkbox nor lock', () => {
  it('ErrorNode has no checkbox and no lock', () => {
    const node = new ErrorNode('boom');
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });

  it('EmptyNode has no checkbox and no lock', () => {
    const node = new EmptyNode();
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });
});

describe('PluginListProvider — rows come from the Instance value', () => {
  it('builds one row per plugins.txt line, in Plugin load order, with the enabled checkbox', async () => {
    const provider = makeProvider([
      plugin({ name: 'A.esp', slot: 0, enabled: false }),
      plugin({ name: 'B.esp', slot: 1, enabled: true }),
    ]);
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeInstanceOf(PluginNode);
    expect(rows[0].label).toBe('A.esp');
    expect((rows[0] as PluginNode).checkboxState).toBe(0); // Unchecked
    expect(rows[1].label).toBe('B.esp');
    expect((rows[1] as PluginNode).checkboxState).toBe(1); // Checked
  });

  it('has no children under a row (flat list)', async () => {
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })]);
    const [row] = await provider.getChildren();
    expect(await provider.getChildren(row)).toEqual([]);
  });

  it('renders a single "No plugins" node when the Instance value carries none', async () => {
    const provider = makeProvider([]);
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
    expect(rows[0].label).toBe('No plugins');
  });

  // Rival: the provider falls back to some read path of its own instead of the injected value.
  // With that rival, this fixture's rows would be empty/wrong rather than what the value says.
  it('rows exactly match the fixture value — not a re-derivation', async () => {
    const provider = makeProvider([
      plugin({ name: 'Zed.esp', slot: 0, enabled: true }),
      plugin({ name: 'Aardvark.esp', slot: 1, enabled: false }),
    ]);
    const rows = await provider.getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Zed.esp', 'Aardvark.esp']); // file order, not alphabetical
  });

  // A losing copy of a listed name carries the same slot as the winning one (ADR-0044) — it
  // must not become a second row for that name.
  it('a losing copy of a listed name renders no row of its own', async () => {
    const provider = makeProvider([
      plugin({ name: 'Base.esp', slot: 0, origin: 'Winner', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', winning: false }),
    ]);
    const rows = (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');
    expect(rows).toHaveLength(1);
  });

  // A plugin file an enabled mod provides with no plugins.txt line (`slot: null`) is the
  // plugins reconcile's business, never merged in by this provider.
  it('an unlisted plugin copy (slot: null) gets no row', async () => {
    const provider = makeProvider([
      plugin({ name: 'Base.esp', slot: 0 }),
      plugin({ name: 'Unlisted.esp', slot: null, winning: true }),
    ]);
    const rows = (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');
    expect(rows.map((n) => n.plugin.name)).toEqual(['Base.esp']);
  });

  // A listed name no mod provides (e.g. a vanilla master) still gets a row when no game
  // directory is configured — only its path resolution, and any badge relying on it, degrade.
  it('still renders a row for a listed name no mod provides, when the Data folder is unresolved', async () => {
    const provider = makeProvider([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: '/unresolved/Fallout4.esm' }),
      plugin({ name: 'Mod.esp', slot: 1, origin: 'SomeMod' }),
    ], { dataFolder: () => Promise.resolve(undefined) });

    const rows = (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm', 'Mod.esp']);
  });

  // The real shape an unresolved game directory now produces (`LoadOrderPluginLine`): a row
  // with no `path` at all, not a placeholder string. The row still renders, unbadged.
  it('renders a row for a LoadOrderPluginLine (path: undefined), with no badge', async () => {
    const provider = makeProvider([
      plugin({ name: 'Fallout4.esm', slot: 0, origin: 'Data', path: undefined }),
    ]);
    const rows = (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');
    expect(rows.map((n) => n.plugin.name)).toEqual(['Fallout4.esm']);
    expect(rows[0].iconPath).toBeUndefined(); // no path to open, so nothing to badge
  });

  it('resolvePluginPath returns undefined for a LoadOrderPluginLine, never "undefined" as text', async () => {
    const provider = makeProvider([plugin({ name: 'Fallout4.esm', slot: 0, path: undefined })]);
    expect(await provider.resolvePluginPath('Fallout4.esm')).toBeUndefined();
  });

  // Rival: subscribe but drop the callback, or never subscribe — rows would stay at the value
  // handed to the constructor.
  it('re-renders on a new value published after construction', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const provider = makeProvider([], { instance });
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['A.esp']);

    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]));

    expect(fired).toBe(true); // not just the first render — a second, later value re-renders too
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['A.esp', 'B.esp']);
  });

  it('setPluginEnabled delegates to the source and fires a refresh', async () => {
    const source = new FakeSource();
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })], { source });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setPluginEnabled('A.esp', false);

    expect(source.setPluginEnabledCalls).toEqual([{ pluginName: 'A.esp', enabled: false }]);
    expect(fired).toBe(true);
  });

  // The event carries the only source of truth the composition root has for which plugin and
  // which state, so it must match exactly what was written (ADR-0035).
  it('setPluginEnabled fires onDidChangeParticipation with the plugin and its new state', async () => {
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })]);
    const seen: { plugin: string; enabled: boolean }[] = [];
    provider.onDidChangeParticipation((e) => seen.push(e));

    await provider.setPluginEnabled('A.esp', false);

    expect(seen).toEqual([{ plugin: 'A.esp', enabled: false }]);
  });

  // Firing from invalidate() would also fire for a filter keystroke or a watcher-observed edit,
  // neither of which is a participation change a backend should be told about.
  it('invalidate() alone does not fire onDidChangeParticipation', () => {
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })]);
    let fired = false;
    provider.onDidChangeParticipation(() => { fired = true; });

    provider.invalidate();

    expect(fired).toBe(false);
  });

  it('invalidate() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.invalidate();
    expect(fired).toBe(true);
  });

  // Asymmetry test: invalidate() re-pulls the Instance's current value and clears the row
  // cache — unlike setFilter's render-only path, which must leave both alone.
  it('invalidate() clears the cache and re-pulls the current instance value', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const provider = makeProvider([], { instance });
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['A.esp']);

    instance.value = valueOf([plugin({ name: 'A.esp', slot: 0 }), plugin({ name: 'B.esp', slot: 1 })]); // no publish()

    provider.invalidate();

    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['A.esp', 'B.esp']);
  });

  // sequence === 0 means "the Instance has not read yet", never "genuinely empty" — a real
  // empty plugins.txt lands at sequence 1. getChildren() must not claim "No plugins" for the
  // former; it awaits the first landed value instead.
  it('does not resolve getChildren() until the Instance lands its first value (sequence 0)', async () => {
    const instance = new FakeInstance(valueOf([]), 0);
    const provider = makeProvider([], { instance });

    let settled = false;
    const pending = provider.getChildren().then((rows) => { settled = true; return rows; });
    // A macrotask boundary, not a microtask one: buildRows() itself hops several microtasks
    // (dataFolder(), implicitMasters()), so a single `await Promise.resolve()` would
    // pass whether or not getChildren() actually waits on the Instance.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    instance.publish(valueOf([plugin({ name: 'A.esp', slot: 0 })]));
    const rows = await pending;

    expect(settled).toBe(true);
    expect(rows.map((r) => r.label)).toEqual(['A.esp']);
  });

  // A genuinely empty plugins.txt (sequence already past 0) is not "not read yet" — it must
  // still render EmptyNode honestly, not hang waiting for a value that already landed.
  it('renders EmptyNode immediately when the first landed value is genuinely empty', async () => {
    const provider = makeProvider([], { instance: new FakeInstance(valueOf([]), 1) });
    const rows = await provider.getChildren();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
  });
});

describe('PluginListProvider — filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const provider = makeProvider([
      plugin({ name: 'Alpha.esp', slot: 0 }),
      plugin({ name: 'Beta.esp', slot: 1 }),
      plugin({ name: 'AlphaExtra.esp', slot: 2 }),
    ]);
    provider.setFilter('ALPHA');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('restores the full list when the filter is cleared', async () => {
    const provider = makeProvider([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]);
    provider.setFilter('alpha');
    expect(await provider.getChildren()).toHaveLength(1);

    provider.setFilter('');
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('returns an empty list (not the "No plugins" node) when the filter matches nothing', async () => {
    const provider = makeProvider([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]);
    provider.setFilter('nomatch');
    const rows = await provider.getChildren();

    expect(rows).toEqual([]);
    expect(rows.some((r) => r instanceof EmptyNode)).toBe(false);
  });

  // The filter outlives a Refresh and whatever the re-pulled value turns up: invalidate() clears
  // the row cache and must not touch the term.
  it('survives an invalidate() and an underlying value change, narrowing whatever it turns up', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const provider = makeProvider([], { instance });
    provider.setFilter('alpha');
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp']);

    instance.value = valueOf([
      plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 }), plugin({ name: 'AlphaTwo.esp', slot: 2 }),
    ]);
    provider.invalidate();

    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp', 'AlphaTwo.esp']);
  });

  it('fires onDidChangeTreeData when the filter is set', () => {
    const provider = makeProvider([plugin({ name: 'Alpha.esp', slot: 0 })]);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setFilter('a');
    expect(fired).toBe(true);
  });

  // A filter keystroke must re-render already-built rows, never rebuild them from the Instance
  // value.
  it('does not rebuild rows (render-only, not invalidate)', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const provider = makeProvider([], { instance });
    await provider.getChildren(); // populates the cache off the value above

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]); // no publish(), no invalidate()
    provider.setFilter('a');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']); // the stale cache, not the mutated value
  });

  it('clearing the filter restores all cached rows, without rebuilding', async () => {
    const instance = new FakeInstance(valueOf([plugin({ name: 'Alpha.esp', slot: 0 }), plugin({ name: 'Beta.esp', slot: 1 })]));
    const provider = makeProvider([], { instance });
    await provider.getChildren();
    provider.setFilter('alpha');
    await provider.getChildren();

    instance.value = valueOf([plugin({ name: 'Alpha.esp', slot: 0 })]); // no publish(), no invalidate()
    provider.setFilter('');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });
});

// Every master verdict is the backend's, applied by PluginsTreeComposite over these rows: a row
// this provider builds carries no badge of its own (ADR-0021).
describe('PluginNode', () => {
  it('renders a plain row — no icon, no description', () => {
    const node = new PluginNode({ name: 'A.esp', enabled: true });
    expect(node.iconPath).toBeUndefined();
    expect(node.description).toBeUndefined();
  });
});

// Minimal DataTransfer double: handleDrag writes a DataTransferItem, handleDrop reads it.
class FakeDataTransfer {
  private readonly map = new Map<string, { value: unknown }>();
  set(mime: string, item: { value: unknown }) { this.map.set(mime, item); }
  get(mime: string) { return this.map.get(mime); }
}
const NONE = undefined as never; // the drag/drop methods ignore the CancellationToken

describe('PluginListProvider — drag-and-drop reorder', () => {
  const ORDER = ['A.esp', 'B.esp', 'C.esp', 'D.esp', 'E.esp'];
  const fixturePlugins = (names: string[] = ORDER) => names.map((name, slot) => plugin({ name, slot }));
  const node = (name: string) => new PluginNode({ name, enabled: true });

  async function drag(source: FakeSource, moved: string[], target: string | undefined, names: string[] = ORDER) {
    const reports: { severity: string; message: string }[] = [];
    const provider = new PluginListProvider({
      instance: new FakeInstance(valueOf(fixturePlugins(names))),
      source,
      reporter: { report: (severity, message) => reports.push({ severity, message }) },
    });
    await provider.getChildren(); // populate the cached order
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    const dt = new FakeDataTransfer();
    provider.handleDrag(moved.map(node), dt as never, NONE);
    await provider.handleDrop(target === undefined ? undefined : node(target), dt as never, NONE);
    return { reports, fired };
  }

  it('handleDrag serialises the whole selection, not just the grabbed row', () => {
    const provider = makeProvider(fixturePlugins());
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp'), node('C.esp')], dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['A.esp', 'C.esp']);
  });

  it('handleDrag ignores non-plugin nodes (Empty) in the selection', () => {
    const provider = makeProvider(fixturePlugins());
    const dt = new FakeDataTransfer();
    provider.handleDrag([new EmptyNode(), node('B.esp')], dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['B.esp']);
  });

  it('single-row down-drag onto a lower row reorders with the post-removal index', async () => {
    const source = new FakeSource();
    const { fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], toIndex: 2 }]);
    expect(fired).toBe(true);
  });

  it('drop past the last row (undefined target) appends', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp'], undefined);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], toIndex: 4 }]);
  });

  it('drop onto a non-plugin node (empty state) appends', async () => {
    const source = new FakeSource();
    const provider = makeProvider([plugin({ name: 'A.esp', slot: 0 })], { source });
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp')], dt as never, NONE);
    await provider.handleDrop(new EmptyNode(), dt as never, NONE);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], toIndex: 0 }]);
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
    const provider = makeProvider(fixturePlugins(), { source });
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp')], dt as never, NONE);

    await provider.handleDrop({ kind: 'record' } as never, dt as never, NONE);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('contiguous multi-selection moves as a block to the target index', async () => {
    const source = new FakeSource();
    await drag(source, ['B.esp', 'C.esp', 'D.esp'], 'A.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp', 'C.esp', 'D.esp'], toIndex: 0 }]);
  });

  it('non-contiguous multi-selection counts only moved rows above the target', async () => {
    const source = new FakeSource();
    await drag(source, ['A.esp', 'C.esp', 'E.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp', 'C.esp', 'E.esp'], toIndex: 1 }]);
  });

  it('an empty drag payload is a no-op (no write)', async () => {
    const source = new FakeSource();
    const provider = makeProvider(fixturePlugins(), { source });
    await provider.getChildren();
    await provider.handleDrop(node('A.esp'), new FakeDataTransfer() as never, NONE);
    expect(source.reorderPluginsCalls).toEqual([]);
  });

  // A drop position comes from the full plugins.txt order, never the displayed row list: a name
  // filter narrows which rows show, not the load order they belong to (ADR-0035).
  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const NAMES = ['M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'];

    const baselineSource = new FakeSource();
    await drag(baselineSource, ['M1.esp'], 'M3.esp', NAMES);

    const filteredSource = new FakeSource();
    const provider = new PluginListProvider({ instance: new FakeInstance(valueOf(fixturePlugins(NAMES))), source: filteredSource });
    await provider.getChildren(); // populate the cached order
    provider.setFilter('m'); // matches M1/M2/M3 only — X1.esp sits hidden between the drag and its target
    const visible = await provider.getChildren();
    expect(visible.map((n) => (n as PluginNode).plugin.name)).toEqual(['M1.esp', 'M2.esp', 'M3.esp']);

    const dt = new FakeDataTransfer();
    provider.handleDrag([node('M1.esp')], dt as never, NONE);
    await provider.handleDrop(node('M3.esp'), dt as never, NONE);

    expect(filteredSource.reorderPluginsCalls).toEqual(baselineSource.reorderPluginsCalls);
  });

  it('surfaces a write failure via the reporter and resyncs the tree (ADR-0026)', async () => {
    const source = new FakeSource();
    source.reorderPluginsError = new Error('disk full');
    const { reports, fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(reports).toHaveLength(1);
    expect(reports[0].severity).toBe('error');
    expect(fired).toBe(true); // refresh fired to resync the moved row
  });
});

// End-to-end: the real reorder command over a temp plugins.txt, driven through the provider's
// drag → drop, asserting the on-disk order and byte-faithfulness — independent of the fixture
// value that supplies the rows being dragged.
describe('PluginListProvider — drag reorder round-trips through plugins.txt on disk', () => {
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
    const provider = new PluginListProvider({ instance: new FakeInstance(valueOf(fixturePlugins())), source });
    await provider.getChildren(); // cache the rendered order
    const dt = new FakeDataTransfer();
    provider.handleDrag(moved.map(node), dt as never, NONE);
    await provider.handleDrop(target === undefined ? undefined : node(target), dt as never, NONE);
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
});

describe('PluginListProvider — resolvePluginPath (Reveal in Explorer)', () => {
  it('resolves a plugin name to its winning copy\'s path', async () => {
    const provider = makeProvider([
      plugin({ name: 'Base.esp', slot: 0, path: '/data/mods/Winner/Base.esp', winning: true }),
      plugin({ name: 'Base.esp', slot: 0, origin: 'Loser', path: '/data/mods/Loser/Base.esp', winning: false }),
    ]);
    expect(await provider.resolvePluginPath('Base.esp')).toBe('/data/mods/Winner/Base.esp');
  });

  it('returns undefined for a name with no winning copy', async () => {
    const provider = makeProvider([plugin({ name: 'Base.esp', slot: 0, winning: false })]);
    expect(await provider.resolvePluginPath('Base.esp')).toBeUndefined();
  });

  it('returns undefined for an unknown name', async () => {
    const provider = makeProvider([plugin({ name: 'Base.esp', slot: 0 })]);
    expect(await provider.resolvePluginPath('NoSuchPlugin.esp')).toBeUndefined();
  });
});

// Implicit masters render as forced-on rows ahead of plugins.txt's lines. The backend names
// them (ADR-0021); this provider only places them.
describe('PluginListProvider — implicit master rows', () => {
  const DATA = '/game/Data';
  // `null` stands for the absence in both slots: a backend that could not answer, and an
  // unresolved Data folder. An explicit `undefined` would select the default instead.
  const providerFor = (
    plugins: (LoadOrderPlugin | LoadOrderPluginLine)[],
    implicit: readonly string[] | null = [],
    folder: string | null = DATA,
  ) => makeProvider(plugins, {
    dataFolder: () => Promise.resolve(folder ?? undefined),
    implicitMasters: () => Promise.resolve(implicit ?? undefined),
  });

  it('renders the backend\'s names as ImplicitMasterNode rows preceding plugins.txt rows, in the order given, with no checkbox and contextValue pluginImplicit', async () => {
    // The backend answers in load order; the tree preserves it rather than sorting, which would
    // put DLCCoast.esm ahead of the Fallout4.esm it masters.
    const rows = await providerFor(
      [plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm', 'DLCCoast.esm'],
    ).getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm', 'DLCCoast.esm', 'Mod.esp']);
    expect(rows[0]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[1]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[0].contextValue).toBe('pluginImplicit');
    expect((rows[0] as ImplicitMasterNode).checkboxState).toBeUndefined();
    expect(rows[2]).toBeInstanceOf(PluginNode);
  });

  it('resolves each implicit row\'s file inside the Data folder, for the graying decoration to key on', async () => {
    const rows = await providerFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']).getChildren();
    expect((rows[0] as ImplicitMasterNode).resourceUri).toEqual({ fsPath: '/game/Data/Fallout4.esm' });
  });

  it('a name the backend calls implicit which plugins.txt also lists renders exactly once, as the implicit row (real LitR CC .esl case)', async () => {
    const rows = await providerFor([
      plugin({ name: 'Fallout4.esm', slot: 0 }),
      plugin({ name: 'ccBGSFO4044-HellfirePowerArmor.esl', slot: 1 }),
    ], ['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']).getChildren();

    const labels = rows.map((r) => r.label);
    expect(labels).toEqual(['Fallout4.esm', 'ccBGSFO4044-HellfirePowerArmor.esl']);
    expect(rows.every((r) => r instanceof ImplicitMasterNode)).toBe(true);
  });

  it('matches a plugins.txt line to an implicit name case-insensitively', async () => {
    const rows = await providerFor([plugin({ name: 'FALLOUT4.ESM', slot: 0 })], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('publishes the implicit names, lowercased, for the graying decoration provider', async () => {
    const provider = providerFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']);
    await provider.getChildren();
    expect([...provider.implicitMasterNames()]).toEqual(['fallout4.esm']);
  });

  // The rival: treating an unreachable backend as "no implicit masters" here would be harmless,
  // but it must not invent rows either — an unknown answer renders nothing, and the tree still
  // renders every plugins.txt line.
  it('renders no implicit row, and every plugins.txt line, when the backend cannot be reached', async () => {
    const rows = await providerFor([plugin({ name: 'Mod.esp', slot: 0 })], null).getChildren();

    expect(rows.some((r) => r instanceof ImplicitMasterNode)).toBe(false);
    expect(rows.map((r) => r.label)).toEqual(['Mod.esp']);
    expect([...providerFor([], null).implicitMasterNames()]).toEqual([]);
  });

  it('renders only implicit rows when plugins.txt is empty, rather than the empty state', async () => {
    const rows = await providerFor([], ['Fallout4.esm']).getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm']);
  });

  it('leaves an implicit row without a resourceUri when the Data folder is unresolved', async () => {
    const rows = await providerFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm'], null).getChildren();
    expect((rows[0] as ImplicitMasterNode).resourceUri).toBeUndefined();
  });

  it('handleDrag still filters to only "plugin" nodes, excluding implicit rows for free (no code change needed)', async () => {
    const provider = providerFor([plugin({ name: 'Mod.esp', slot: 0 })], ['Fallout4.esm']);
    const rows = await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag(rows, dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['Mod.esp']);
  });
});

// The implicit block has no plugins.txt line, so a drop onto it lands at file-index 0 —
// computed from the fixture's slots, never the implicit names.
describe('PluginListProvider — implicit master drop-index mapping', () => {
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
    const provider = new PluginListProvider({ instance: new FakeInstance(valueOf(fixturePlugins())), source });
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag(moved.map(node), dt as never, NONE);
    await provider.handleDrop(target, dt as never, NONE);
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
