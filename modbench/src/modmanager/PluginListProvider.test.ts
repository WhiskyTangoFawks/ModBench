import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModlistEntry } from './model';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { buildTes4Buffer } from './test/buildTes4Buffer';
import {
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  uriFilePlain, DataTransferItem, DataTransfer,
} from '../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState, EventEmitter, ThemeIcon,
  Uri: { file: uriFilePlain }, DataTransferItem, DataTransfer,
}));

import {
  PluginListProvider, PluginNode, ImplicitMasterNode, EmptyNode, pluginFileOf, orderIssueMastersOf,
  type PluginListSource,
} from './PluginListProvider';
import { ErrorNode } from './ErrorNode';

/** Implements exactly PluginListProvider's own Pick<> of IModlistSource — a method the provider
 *  doesn't touch can't even be added here by mistake. readModlist is part of that set but never
 *  exercised by these tests (the instanceRoot fixtures further down use the real
 *  Mo2ModlistSource instead), so it stays an 'unused' stub rather than a real implementation. */
class FakeSource implements PluginListSource {
  setPluginEnabledCalls: { pluginName: string; enabled: boolean }[] = [];
  reorderPluginsCalls: { names: string[]; toIndex: number }[] = [];
  reorderPluginsError?: Error;
  readPluginOrderCalls = 0;
  readEnabledPluginsCalls = 0;
  constructor(
    private readonly order: string[] | Error,
    private readonly enabled: string[] = [],
  ) {}
  readPluginOrder(): Promise<string[]> {
    this.readPluginOrderCalls++;
    return this.order instanceof Error ? Promise.reject(this.order) : Promise.resolve(this.order);
  }
  readEnabledPlugins(): Promise<string[]> {
    this.readEnabledPluginsCalls++;
    return this.order instanceof Error ? Promise.reject(this.order) : Promise.resolve(this.enabled);
  }
  readModlist(): Promise<ModlistEntry[]> { throw new Error('unused'); }
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

// The leading slot answers exactly one question — "can you change whether this loads?"
// ImplicitMasterNode already renders no checkbox (nothing to toggle); it now also renders a lock
// where a togglable row renders a checkbox, so the empty slot isn't mistakable for "no plugin
// here". Icon/tooltip only — the platform has no non-interactive checkbox variant
// (TreeItemCheckboxState is Checked/Unchecked only), so MO2's own grayed-but-checked-and-disabled
// checkbox can't be reproduced; the label-graying and tooltip wording it does allow are adopted
// verbatim (see ImplicitMasterDecorationProvider for the label graying).
describe('ImplicitMasterNode — leading slot (#276)', () => {
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

// Clicking a plugin row opens its file header (xEdit parity — vstNavChange/
// TryViewOrCompareSelectedRecords, xeMainForm.pas — selecting a plugin node shows its File Header
// as a matter of course, no separate affordance). Routed through the existing modbench.openHeader
// bridge command (extension.ts) rather than reaching for headerFormKeyFor/formKey directly here —
// this file is forbidden record vocabulary (contextBoundary.test.ts), and openHeader already does
// the pluginFileOf -> headerFormKeyFor -> modbench.openEditor(singleton) translation on the
// composition-root side of that boundary.
describe('PluginNode / ImplicitMasterNode — row click opens the plugin header (#345)', () => {
  it('PluginNode wires .command to modbench.openHeader, passing itself', () => {
    const node = new PluginNode({ name: 'TestMod.esp', enabled: true });
    expect(node.command).toEqual({ command: 'modbench.openHeader', title: 'Open Header', arguments: [node] });
  });

  it('ImplicitMasterNode wires .command to modbench.openHeader, passing itself', () => {
    const node = new ImplicitMasterNode('Fallout4.esm');
    expect(node.command).toEqual({ command: 'modbench.openHeader', title: 'Open Header', arguments: [node] });
  });
});

// A row that stands for no plugin file in the load order at all — today that's only the
// sentinel ErrorNode/EmptyNode rows — renders
// neither a checkbox nor a lock. Guards against giving the
// lock icon too broadly (e.g. to every non-PluginNode row) instead of scoping it to
// ImplicitMasterNode specifically.
describe('leading slot — rows outside the load order render neither checkbox nor lock (#276 AC3)', () => {
  it('ErrorNode has no checkbox and no lock', () => {
    const node = new ErrorNode('boom');
    expect(node.label).toBe('⚠ Failed to load: boom');
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });

  it('EmptyNode has no checkbox and no lock', () => {
    const node = new EmptyNode();
    expect(node.checkboxState).toBeUndefined();
    expect(node.iconPath).not.toEqual({ id: 'lock' });
  });
});

describe('PluginListProvider', () => {
  it('builds one row per plugins.txt line, in Plugin load order, with the enabled checkbox', async () => {
    const provider = new PluginListProvider({ source: new FakeSource(['A.esp', 'B.esp'], ['B.esp']) });
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeInstanceOf(PluginNode);
    expect(rows[0].label).toBe('A.esp');
    expect((rows[0] as PluginNode).checkboxState).toBe(0); // Unchecked
    expect(rows[1].label).toBe('B.esp');
    expect((rows[1] as PluginNode).checkboxState).toBe(1); // Checked
  });

  it('has no children under a row (flat list)', async () => {
    const provider = new PluginListProvider({ source: new FakeSource(['A.esp'], ['A.esp']) });
    const [row] = await provider.getChildren();
    expect(await provider.getChildren(row)).toEqual([]);
  });

  it('renders a single error node when plugins.txt cannot be read', async () => {
    const logged: string[] = [];
    const provider = new PluginListProvider({ source: new FakeSource(new Error('boom')), log: (m) => logged.push(m) });
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(ErrorNode);
    expect(rows[0].tooltip).toBe('boom');
    expect(logged.join('\n')).toContain('boom');
  });

  it('renders a single "No plugins" node when plugins.txt is empty', async () => {
    const provider = new PluginListProvider({ source: new FakeSource([]) });
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
    expect(rows[0].label).toBe('No plugins');
  });

  it('setPluginEnabled delegates to the source and fires a refresh', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider({ source });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setPluginEnabled('A.esp', false);

    expect(source.setPluginEnabledCalls).toEqual([{ pluginName: 'A.esp', enabled: false }]);
    expect(fired).toBe(true);
  });

  // Asymmetry test: setPluginEnabled must invalidate — the next
  // getChildren() has to re-read the source, since the toggle changed plugins.txt.
  it('setPluginEnabled invalidates: a subsequent getChildren() re-reads the source', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const callsAfterFirstRead = source.readPluginOrderCalls;

    await provider.setPluginEnabled('A.esp', false);
    await provider.getChildren();

    expect(source.readPluginOrderCalls).toBeGreaterThan(callsAfterFirstRead);
  });

  // ADR-0035 § Live mutation: the composition root's cue to apply the same participation
  // change to a running backend. Named plugin/enabled must match exactly what was
  // written, since the backend call the composition root makes off this carries no other source
  // of truth for which plugin or which state.
  it('setPluginEnabled fires onDidChangeParticipation with the plugin and its new state', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider({ source });
    const seen: { plugin: string; enabled: boolean }[] = [];
    provider.onDidChangeParticipation((e) => seen.push(e));

    await provider.setPluginEnabled('A.esp', false);

    expect(seen).toEqual([{ plugin: 'A.esp', enabled: false }]);
  });

  // Rival named: an implementation that fires onDidChangeParticipation from invalidate() itself
  // (reusing onDidChangeTreeData's own generic "something changed" firing) would also fire it for
  // a filter keystroke or an external plugins.txt edit picked up by a watcher — neither is a
  // participation change a backend should be told about. This is the test that would
  // catch that: invalidate() alone must never fire it.
  it('invalidate() alone does not fire onDidChangeParticipation', () => {
    const provider = new PluginListProvider({ source: new FakeSource(['A.esp']) });
    let fired = false;
    provider.onDidChangeParticipation(() => { fired = true; });

    provider.invalidate();

    expect(fired).toBe(false);
  });

  it('invalidate() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const provider = new PluginListProvider({ source: new FakeSource(['A.esp']) });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.invalidate();
    expect(fired).toBe(true);
  });

  // Asymmetry test: invalidate() clears the cache, so the next
  // getChildren() must re-read the source — unlike setFilter's render-only path.
  it('invalidate() clears the cache: a subsequent getChildren() re-reads the source', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const callsAfterFirstRead = source.readPluginOrderCalls;

    provider.invalidate();
    await provider.getChildren();

    expect(source.readPluginOrderCalls).toBeGreaterThan(callsAfterFirstRead);
  });
});

describe('PluginListProvider — filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const provider = new PluginListProvider({ source: new FakeSource(['Alpha.esp', 'Beta.esp', 'AlphaExtra.esp']) });
    provider.setFilter('ALPHA');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('restores the full list when the filter is cleared', async () => {
    const provider = new PluginListProvider({ source: new FakeSource(['Alpha.esp', 'Beta.esp']) });
    provider.setFilter('alpha');
    expect(await provider.getChildren()).toHaveLength(1);

    provider.setFilter('');
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('returns an empty list (not the "No plugins" node) when the filter matches nothing', async () => {
    const provider = new PluginListProvider({ source: new FakeSource(['Alpha.esp', 'Beta.esp']) });
    provider.setFilter('nomatch');
    const rows = await provider.getChildren();

    expect(rows).toEqual([]);
    expect(rows.some((r) => r instanceof EmptyNode)).toBe(false);
  });

  // The filter is durable within the load order — it outlives a Refresh and whatever the
  // re-read turns up. The render-vs-invalidate split is what makes that true, so this is
  // the test that says so: invalidate() clears the row cache and must not touch the term.
  it('survives a refresh and an underlying data change, narrowing whatever the re-read returns', async () => {
    const order = ['Alpha.esp', 'Beta.esp'];
    const provider = new PluginListProvider({ source: new FakeSource(order) });
    provider.setFilter('alpha');
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp']);

    order.push('AlphaTwo.esp'); // a plugin arrives on disk
    provider.invalidate();      // …and Refresh re-reads

    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp', 'AlphaTwo.esp']);
  });

  it('fires onDidChangeTreeData when the filter is set', () => {
    const provider = new PluginListProvider({ source: new FakeSource(['Alpha.esp']) });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setFilter('a');
    expect(fired).toBe(true);
  });

  // A filter keystroke must re-render already-built rows, never
  // re-read plugins.txt/enabled state.
  it('does not re-read the source (render-only, not invalidate)', async () => {
    const source = new FakeSource(['Alpha.esp', 'Beta.esp']);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const orderCallsAfterFirstRead = source.readPluginOrderCalls;
    const enabledCallsAfterFirstRead = source.readEnabledPluginsCalls;

    provider.setFilter('alpha');
    await provider.getChildren();

    expect(source.readPluginOrderCalls).toBe(orderCallsAfterFirstRead);
    expect(source.readEnabledPluginsCalls).toBe(enabledCallsAfterFirstRead);
  });

  // Mirror of ModListProvider: clearing the filter must restore all
  // rows from the cache too, without triggering a re-read.
  it('clearing the filter restores all rows without re-reading the source', async () => {
    const source = new FakeSource(['Alpha.esp', 'Beta.esp']);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    provider.setFilter('alpha');
    await provider.getChildren();
    const callsAfterFilteredRead = source.readPluginOrderCalls;

    provider.setFilter('');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']);
    expect(source.readPluginOrderCalls).toBe(callsAfterFilteredRead);
  });
});

describe('PluginNode — order-aware missing-master badge', () => {
  it('overlays an error icon, description, and per-master tooltip when a master is not loaded before it', () => {
    const node = new PluginNode({ name: 'Child.esp', enabled: true }, { kind: 'masterNotLoadedBefore', masters: ['Base.esp'] });
    expect(node.iconPath).toEqual({ id: 'error' });
    expect(node.description).toContain('not loaded before');
    expect(node.tooltip).toContain('Base.esp');
    expect(node.tooltip).toContain('is not loaded before this plugin');
  });

  it("uses wording distinct from the Mods tree's presence-only badge", () => {
    const node = new PluginNode({ name: 'Child.esp', enabled: true }, { kind: 'masterNotLoadedBefore', masters: ['Base.esp'] });
    // The Mods tree says "Missing master:" — this order-aware badge must not, so the
    // two never read as contradicting each other when they legitimately disagree.
    expect(String(node.tooltip)).not.toContain('Missing master:');
    expect(String(node.description)).not.toContain('Missing master:');
  });

  it('summarises the count when more than one master is out of order', () => {
    const node = new PluginNode({ name: 'Child.esp', enabled: true }, { kind: 'masterNotLoadedBefore', masters: ['Base.esp', 'Other.esp'] });
    expect(node.description).toContain('2');
    expect(node.tooltip).toContain('Base.esp');
    expect(node.tooltip).toContain('Other.esp');
  });

  it('renders a plain row (no badge) with no status or an ok status', () => {
    const plain = new PluginNode({ name: 'A.esp', enabled: true });
    expect(plain.iconPath).toBeUndefined();
    expect(plain.description).toBeUndefined();

    const ok = new PluginNode({ name: 'A.esp', enabled: true }, { kind: 'ok' });
    expect(ok.iconPath).toBeUndefined();
    expect(ok.description).toBeUndefined();
  });
});

// ADR-0037: the composite's load order-aware reconciliation needs the raw master names
// this row's order-aware badge flagged, structurally — not by parsing the rendered tooltip text
// (fragile, and out of reach for a composite that must import no Mod-Management vocabulary).
describe('orderIssueMastersOf', () => {
  it('returns the flagged master names for a masterNotLoadedBefore row', () => {
    const node = new PluginNode({ name: 'Child.esp', enabled: true }, { kind: 'masterNotLoadedBefore', masters: ['Base.esp', 'Other.esp'] });
    expect(orderIssueMastersOf(node)).toEqual(['Base.esp', 'Other.esp']);
  });

  it('returns undefined for a plain row, an ok status, or a non-plugin row', () => {
    expect(orderIssueMastersOf(new PluginNode({ name: 'A.esp', enabled: true }))).toBeUndefined();
    expect(orderIssueMastersOf(new PluginNode({ name: 'A.esp', enabled: true }, { kind: 'ok' }))).toBeUndefined();
    expect(orderIssueMastersOf(new ImplicitMasterNode('Fallout4.esm'))).toBeUndefined();
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
  const node = (name: string) => new PluginNode({ name, enabled: true });

  /** Render once so the provider caches the order, then run a drag → drop. */
  async function drag(source: FakeSource, moved: string[], target: string | undefined) {
    const reports: { severity: string; message: string }[] = [];
    const provider = new PluginListProvider({
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
    const provider = new PluginListProvider({ source: new FakeSource(ORDER) });
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp'), node('C.esp')], dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['A.esp', 'C.esp']);
  });

  it('handleDrag ignores non-plugin nodes (Empty/Error) in the selection', () => {
    const provider = new PluginListProvider({ source: new FakeSource(ORDER) });
    const dt = new FakeDataTransfer();
    provider.handleDrag([new EmptyNode(), node('B.esp')], dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['B.esp']);
  });

  it('single-row down-drag onto a lower row reorders with the post-removal index', async () => {
    const source = new FakeSource(ORDER);
    const { fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], toIndex: 2 }]);
    expect(fired).toBe(true);
  });

  it('drop past the last row (undefined target) appends', async () => {
    const source = new FakeSource(ORDER);
    await drag(source, ['B.esp'], undefined);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp'], toIndex: 4 }]);
  });

  it('drop onto a non-plugin node (empty state) appends', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp')], dt as never, NONE);
    await provider.handleDrop(new EmptyNode(), dt as never, NONE);
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp'], toIndex: 0 }]);
  });

  // Rows have children now, so VS Code can hand this controller a drop target that is not
  // one of its rows at all. "Not my row" is not the same as "past the last row" — that reads as
  // the end of the load order, so a drop into an expanded plugin's records would silently move
  // the dragged plugins to the bottom of plugins.txt.
  it('pluginFileOf names the file a row stands for, and nothing for the rows that stand for none', () => {
    expect(pluginFileOf(node('A.esp'))).toBe('A.esp');
    expect(pluginFileOf(new ImplicitMasterNode('Fallout4.esm'))).toBe('Fallout4.esm');
    expect(pluginFileOf(new EmptyNode())).toBeUndefined();
    expect(pluginFileOf(new ErrorNode('boom'))).toBeUndefined();
  });

  it('drop onto a row this tree does not own is refused, not treated as the end of the list', async () => {
    const source = new FakeSource(ORDER);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp')], dt as never, NONE);

    await provider.handleDrop({ kind: 'record' } as never, dt as never, NONE);

    expect(source.reorderPluginsCalls).toEqual([]);
  });

  it('contiguous multi-selection moves as a block to the target index', async () => {
    const source = new FakeSource(ORDER);
    await drag(source, ['B.esp', 'C.esp', 'D.esp'], 'A.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['B.esp', 'C.esp', 'D.esp'], toIndex: 0 }]);
  });

  it('non-contiguous multi-selection counts only moved rows above the target', async () => {
    const source = new FakeSource(ORDER);
    await drag(source, ['A.esp', 'C.esp', 'E.esp'], 'D.esp');
    expect(source.reorderPluginsCalls).toEqual([{ names: ['A.esp', 'C.esp', 'E.esp'], toIndex: 1 }]);
  });

  it('an empty drag payload is a no-op (no write)', async () => {
    const source = new FakeSource(ORDER);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    await provider.handleDrop(node('A.esp'), new FakeDataTransfer() as never, NONE);
    expect(source.reorderPluginsCalls).toEqual([]);
  });

  // ADR-0035: the position a drop computes has to come from the full plugins.txt
  // order, never the filtered/displayed row list — a name filter narrows *which rows show*, not
  // the load order they belong to. `dropIndexFor` computes against `this.lastOrder`
  // (plugins.txt's raw order) rather than `getChildren()`'s filtered output; this pins that
  // invariant explicitly.
  it('produces the same load-order position with a name filter hiding a row between the drag and its target, as with no filter at all', async () => {
    const ORDER = ['M1.esp', 'M2.esp', 'X1.esp', 'M3.esp', 'X2.esp'];

    const baselineSource = new FakeSource(ORDER);
    await drag(baselineSource, ['M1.esp'], 'M3.esp');

    const filteredSource = new FakeSource(ORDER);
    const provider = new PluginListProvider({ source: filteredSource });
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
    const source = new FakeSource(ORDER);
    source.reorderPluginsError = new Error('disk full');
    const { reports, fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(reports).toHaveLength(1);
    expect(reports[0].severity).toBe('error');
    expect(fired).toBe(true); // refresh fired to resync the moved row
  });

  // Asymmetry test: a successful drop must invalidate — the next
  // getChildren() has to re-read the source, since the drop changed plugins.txt.
  it('a successful drop invalidates: a subsequent getChildren() re-reads the source', async () => {
    const source = new FakeSource(ORDER);
    const provider = new PluginListProvider({ source });
    await provider.getChildren();
    const callsAfterFirstRead = source.readPluginOrderCalls;

    const dt = new FakeDataTransfer();
    provider.handleDrag(['A.esp'].map(node), dt as never, NONE);
    await provider.handleDrop(node('D.esp'), dt as never, NONE);
    await provider.getChildren();

    expect(source.readPluginOrderCalls).toBeGreaterThan(callsAfterFirstRead);
  });
});

// End-to-end: the real Mo2ModlistSource over a temp plugins.txt, driven through the
// provider's drag → drop, asserting the on-disk order and byte-faithfulness — a
// round-trip through the tree and the file, no VS Code process.
describe('PluginListProvider — drag reorder round-trips through plugins.txt on disk', () => {
  let dir: string;
  let source: Mo2ModlistSource;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const node = (name: string) => new PluginNode({ name, enabled: true });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-dnd-'));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\nselected_profile=@ByteArray(Default)\n');
    await writeFile(pluginsTxt(), '# header\r\n*A.esp\r\nB.esp\r\n*C.esp\r\nD.esp\r\nE.esp\r\n');
    source = new Mo2ModlistSource(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dragToDisk(moved: string[], target: string | undefined) {
    const provider = new PluginListProvider({ source });
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
    expect(await source.readPluginOrder()).toEqual(['B.esp', 'A.esp', 'C.esp', 'E.esp', 'D.esp']);
  });

  it('drop past the last row appends the moved row', async () => {
    await dragToDisk(['B.esp'], undefined);
    expect(await source.readPluginOrder()).toEqual(['A.esp', 'C.esp', 'D.esp', 'E.esp', 'B.esp']);
  });
});

// Order-aware missing-master badge wired through the provider over a real MO2
// instance (temp dir, real plugins.txt + mod plugins + a vanilla Data/ plugin),
// mirroring ModListProvider.test.ts's status-badge block but for plugin order.
describe('PluginListProvider — order-aware missing-master badge (instanceRoot provided)', () => {
  let dir: string;
  const pluginNodes = async (provider: PluginListProvider): Promise<PluginNode[]> =>
    (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');
  const byName = (nodes: PluginNode[], name: string) => nodes.find((n) => n.plugin.name === name)!;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-badge-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    // A vanilla plugin no mod provides — resolved via gamePath/Data.
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // Two mods: Provider ships Base.esp; Consumer ships Child.esp mastering Base.esp.
    for (const [modName, file, masters] of [
      ['Provider', 'Base.esp', ['Fallout4.esm']],
      ['Consumer', 'Child.esp', ['Base.esp']],
    ] as const) {
      await mkdir(join(dir, 'mods', modName), { recursive: true });
      await writeFile(join(dir, 'mods', modName, file), buildTes4Buffer([...masters]));
    }
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\nselected_profile=@ByteArray(Default)\r\ngamePath=@ByteArray(${join(dir, 'Game')})\r\n`,
    );
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Consumer\r\n+Provider\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const provider = () =>
    new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: () => Promise.resolve(join(dir, 'Game', 'Data')) });

  it('badges a plugin whose master is sequenced after it', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Child.esp').iconPath).toEqual({ id: 'error' });
    expect(byName(nodes, 'Child.esp').tooltip).toContain('Base.esp');
  });

  it('badges a plugin whose master is absent from plugins.txt entirely', async () => {
    // Child.esp masters Base.esp, but Base.esp has no line at all → flagged.
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Child.esp').iconPath).toEqual({ id: 'error' });
  });

  it('leaves a correctly-ordered plugin unbadged', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nBase.esp\r\nChild.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Child.esp').iconPath).toBeUndefined();
    expect(byName(nodes, 'Base.esp').iconPath).toBeUndefined();
  });

  it('keeps a badge on a filtered-in row (badges computed on the full order, not the visible subset)', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const p = provider();
    p.setFilter('child'); // hides Fallout4.esm + Base.esp, leaving only the out-of-order Child.esp
    const nodes = await pluginNodes(p);
    expect(nodes.map((n) => n.plugin.name)).toEqual(['Child.esp']);
    expect(byName(nodes, 'Child.esp').iconPath).toEqual({ id: 'error' });
  });

  // Same assertion as above, but the filter is set AFTER an initial
  // unfiltered getChildren() — exercising the cache-reuse path in getChildren()
  // (the badge must survive from the cached rows, not a fresh compute).
  it('keeps a badge on a filtered-in row when the filter is set after an initial unfiltered read (cache-reuse path)', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const p = provider();
    const unfiltered = await pluginNodes(p); // populates the cache
    expect(byName(unfiltered, 'Child.esp').iconPath).toEqual({ id: 'error' });

    p.setFilter('child');
    const nodes = await pluginNodes(p);

    expect(nodes.map((n) => n.plugin.name)).toEqual(['Child.esp']);
    expect(byName(nodes, 'Child.esp').iconPath).toEqual({ id: 'error' });
  });

  it('checkMasterOrder itself does not special-case vanilla — a real (non-implicit) plugins.txt master sequenced after its dependent is still flagged (#67 regression, with implicit rows present)', async () => {
    // Base.esp masters a second, mod-provided plugin (Late.esp) sequenced after it in
    // plugins.txt — the check algorithm has no vanilla special-casing; the implicit-row
    // work fixed the ROW SET (vanilla masters are now an implicit, always-first block),
    // not this per-pair order check, which still flags a genuinely-late real-file master.
    await mkdir(join(dir, 'mods', 'Late'), { recursive: true });
    await writeFile(join(dir, 'mods', 'Late', 'Late.esp'), buildTes4Buffer([]));
    await writeFile(join(dir, 'mods', 'Provider', 'Base.esp'), buildTes4Buffer(['Fallout4.esm', 'Late.esp']));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Consumer\r\n+Provider\r\n+Late\r\n');
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nBase.esp\r\nLate.esp\r\nChild.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Base.esp').iconPath).toEqual({ id: 'error' });
    expect(byName(nodes, 'Base.esp').tooltip).toContain('Late.esp');
  });

  it('a discovered implicit (vanilla) master never false-flags a plugin declaring it, even if plugins.txt lists it out of position (issue #108 — the bug this fixes)', async () => {
    // Fallout4.esm sequenced AFTER Base.esp in plugins.txt's raw text — under the old
    // row set this would have flagged Base.esp. Fallout4.esm is discovered from
    // dataFolder (nlink 1) and rendered as an always-first implicit row, so the game's
    // actual load order (vanilla first) is what's checked, not plugins.txt's stale line.
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Base.esp\r\nFallout4.esm\r\nChild.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Base.esp').iconPath).toBeUndefined();
  });

  // The file index build itself fails here (readModlist hits ENOTDIR before any walk starts), not
  // the narrower badge pass — so the warning must name both things that degrade: badges AND a
  // disk-derived row (issue #617 review) — not just "status", which undersold the second loss.
  it('renders the plain tree (badges AND disk-derived rows degraded) with a warning naming both when the file index build fails', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const logs: string[] = [];
    const reports: { severity: string; message: string }[] = [];
    // instanceRoot pointed at a *file*, not a directory: readModlist hits ENOTDIR,
    // failing the index build without failing the plugins.txt read (which uses the real dir).
    const source = new Mo2ModlistSource(dir);
    const provider = new PluginListProvider({ source, log: (m) => logs.push(m), reporter: { report: (severity, message) => reports.push({ severity, message }) }, instanceRoot: join(dir, 'ModOrganizer.ini') });
    const rows = await provider.getChildren();
    const nodes = rows.filter((n): n is PluginNode => n.kind === 'plugin');

    expect(rows.every((n) => n.kind !== 'error')).toBe(true); // tree still rendered
    expect(byName(nodes, 'Child.esp').iconPath).toBeUndefined(); // no badge — computation failed
    expect(reports).toEqual([{
      severity: 'warning',
      message: expect.stringMatching(/badges.*inaccurate.*plugins\.txt.*missing/s),
    }]);
    expect(logs.some((l) => l.includes('file index build failed'))).toBe(true);
  });
});

// #617: buildRows() previously derived row identity purely from plugins.txt lines, so a plugin
// file present on disk but never given a line could never get a row, no matter what triggered a
// refresh. The maintainer's ruling ("unlisted plugin gets appended, the ux model is same as when
// a mod gets enabled") is read-only: no plugins.txt write, an ordinary PluginNode with no
// distinguishing decoration, checkbox unchecked because it falls out of the normal
// `enabledSet.has(name)` check rather than any special-casing.
describe('PluginListProvider — externally-appeared plugin picked up as an appended row (#617)', () => {
  let dir: string;
  const pluginNodes = async (provider: PluginListProvider): Promise<PluginNode[]> =>
    (await provider.getChildren()).filter((n): n is PluginNode => n.kind === 'plugin');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-unlisted-'));
    await mkdir(join(dir, 'mods', 'Provider'), { recursive: true });
    await writeFile(join(dir, 'mods', 'Provider', 'Base.esp'), buildTes4Buffer([]));
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\nselected_profile=@ByteArray(Default)\r\ngamePath=@ByteArray(${join(dir, 'Game')})\r\n`,
    );
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Provider\r\n');
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Base.esp\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const provider = () => new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir });

  // The survey's own pinned red (`expected [ 'Base.esp' ] to include 'New.esp' ]`), extended to
  // the ruling's full row shape.
  it('a plugin file added to an already-enabled mod after the initial read appears, appended, unchecked and undecorated, once invalidated', async () => {
    const p = provider();
    const before = await pluginNodes(p);
    expect(before.map((n) => n.plugin.name)).toEqual(['Base.esp']);

    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), buildTes4Buffer([]));
    p.invalidate();

    const after = await pluginNodes(p);
    expect(after.map((n) => n.plugin.name)).toEqual(['Base.esp', 'New.esp']);
    const added = after[1];
    expect(added.checkboxState).toBe(0); // Unchecked — no plugins.txt line names it
    expect(added.iconPath).toBeUndefined(); // no distinguishing decoration (ruling rejects one)
    expect(added.description).toBeUndefined();
  });

  // AC3: disable/re-enable must converge to the same state as the watcher path above. Also
  // covers the broader case the coordinator flagged (enabling a mod whose plugin was never in
  // plugins.txt at all, not just one added to an already-enabled mod): buildFileConflictIndex
  // walks only currently-enabled mods regardless of a mod's enable history, so re-enabling
  // Provider exercises exactly that path — no separate test needed for it.
  it('disabling then re-enabling the owning mod converges: the appended row disappears then reappears', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), buildTes4Buffer([]));
    const p = provider();
    expect((await pluginNodes(p)).map((n) => n.plugin.name)).toEqual(['Base.esp', 'New.esp']);

    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '-Provider\r\n');
    p.invalidate();
    // Base.esp keeps its row (it still has a plugins.txt line); New.esp's row — which exists only
    // because Provider's disk contents were walked — vanishes with the mod that provided it.
    expect((await pluginNodes(p)).map((n) => n.plugin.name)).toEqual(['Base.esp']);

    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Provider\r\n');
    p.invalidate();
    const reenabled = await pluginNodes(p);
    expect(reenabled.map((n) => n.plugin.name)).toEqual(['Base.esp', 'New.esp']);
    expect(reenabled[1].checkboxState).toBe(0);
  });

  it('a plugin file that already has a plugins.txt line is not appended a second time', async () => {
    const nodes = await pluginNodes(provider());
    expect(nodes.map((n) => n.plugin.name)).toEqual(['Base.esp']);
  });

  // MO2 users are ordinarily on a case-insensitive filesystem, so a plugins.txt line differing
  // only in case from the on-disk filename (here, "BASE.esp" vs. the real "Base.esp") is a
  // routine occurrence, not a corrupted profile — the fold-based `knownFolded` lookup must still
  // recognise them as the same plugin, or the user sees a spurious duplicate row. Genuinely
  // case-differing (not just already-lowercase, which would pass even with the `.toLowerCase()`
  // fold reverted — a mutation that never exercises the fold proves nothing).
  it('a plugins.txt line differing only in case from the on-disk filename is not appended a second time', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*BASE.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(nodes.map((n) => n.plugin.name)).toEqual(['BASE.esp']);
  });

  // #654: ticking a synthesized (unlisted) row is the user's obvious first gesture on a
  // newly-visible plugin — append it to plugins.txt as enabled, matching what MO2 itself does on
  // save, rather than failing the toggle (the maintainer ruling this session: option 1 of #654).
  it('ticking a synthesized row appends it to plugins.txt, enabled', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), buildTes4Buffer([]));
    const p = provider();
    await pluginNodes(p); // populate the cache

    await p.setPluginEnabled('New.esp', true);

    const pluginsPath = join(dir, 'profiles', 'Default', 'plugins.txt');
    expect(await readFile(pluginsPath, 'utf8')).toBe('*Base.esp\r\n*New.esp\r\n');

    const nodes = await pluginNodes(p);
    expect(nodes.map((n) => n.plugin.name)).toEqual(['Base.esp', 'New.esp']);
    expect(nodes[1].checkboxState).toBe(1); // Checked
  });

  // Rows render unchecked, so this shouldn't normally fire from the UI — but nothing should
  // write plugins.txt in response to a request to disable a line that was never there.
  it('unticking a synthesized row is a no-op: plugins.txt stays byte-identical', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), buildTes4Buffer([]));
    const p = provider();
    await pluginNodes(p); // populate the cache

    const pluginsPath = join(dir, 'profiles', 'Default', 'plugins.txt');
    const before = await readFile(pluginsPath, 'utf8');

    await p.setPluginEnabled('New.esp', false);

    expect(await readFile(pluginsPath, 'utf8')).toBe(before);
  });
});

describe('PluginListProvider — resolvePluginPath (Reveal in Explorer, issue #69)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-reveal-'));
    const dataFolder = join(dir, 'Game', 'Data');
    await mkdir(dataFolder, { recursive: true });
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    // A vanilla plugin no mod provides — resolved via gamePath/Data.
    await writeFile(join(dataFolder, 'Fallout4.esm'), buildTes4Buffer([]));
    // Provider ships Base.esp (a mod-provided winner).
    await mkdir(join(dir, 'mods', 'Provider'), { recursive: true });
    await writeFile(join(dir, 'mods', 'Provider', 'Base.esp'), buildTes4Buffer(['Fallout4.esm']));
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\nselected_profile=@ByteArray(Default)\r\ngamePath=@ByteArray(${join(dir, 'Game')})\r\n`,
    );
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Provider\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves a mod-provided plugin to the winning mod copy', async () => {
    const provider = new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: () => Promise.resolve(join(dir, 'Game', 'Data')) });
    expect(await provider.resolvePluginPath('Base.esp')).toBe(join(dir, 'mods', 'Provider', 'Base.esp'));
  });

  it('resolves an unmanaged vanilla plugin to the game Data folder', async () => {
    const provider = new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: () => Promise.resolve(join(dir, 'Game', 'Data')) });
    expect(await provider.resolvePluginPath('Fallout4.esm')).toBe(join(dir, 'Game', 'Data', 'Fallout4.esm'));
  });

  it('returns undefined without touching the source when no instanceRoot is configured', async () => {
    const source = new FakeSource(['Base.esp']); // readModlist throws if ever called
    const provider = new PluginListProvider({ source });
    expect(await provider.resolvePluginPath('Base.esp')).toBeUndefined();
  });

  it('returns undefined and logs (no throw) when resolution fails', async () => {
    const logs: string[] = [];
    // instanceRoot pointed at a *file*: readModlist hits ENOTDIR.
    const provider = new PluginListProvider({ source: new Mo2ModlistSource(dir), log: (m) => logs.push(m), instanceRoot: join(dir, 'ModOrganizer.ini') });
    expect(await provider.resolvePluginPath('Base.esp')).toBeUndefined();
    expect(logs.some((l) => l.includes('resolvePluginPath'))).toBe(true);
  });
});

// The game's implicitly-loaded vanilla masters (discovered from the
// resolved Data folder — a plugin file that is NOT a hardlink, nlink === 1) render
// as forced-on rows ahead of plugins.txt's own lines, so their absence never makes a
// plugin declaring one show a false "missing master".
describe('PluginListProvider — implicit (vanilla) master rows (issue #108)', () => {
  let dir: string;
  const dataFolder = () => join(dir, 'Game', 'Data');
  const providerFor = (extra: Partial<import('./PluginListProvider').PluginListProviderOptions> = {}) =>
    new PluginListProvider({
      source: new Mo2ModlistSource(dir),
      instanceRoot: dir,
      dataFolder: () => Promise.resolve(dataFolder()),
      ...extra,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-implicit-'));
    await mkdir(dataFolder(), { recursive: true });
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\nselected_profile=@ByteArray(Default)\r\ngamePath=@ByteArray(${join(dir, 'Game')})\r\n`,
    );
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renders implicit masters as ImplicitMasterNode rows preceding plugins.txt rows, in topological order, with no checkbox and contextValue pluginImplicit', async () => {
    // DLCCoast.esm masters Fallout4.esm — alphabetically DLCCoast < Fallout4, which
    // would be wrong; the correct topological order is Fallout4.esm first.
    await writeFile(join(dataFolder(), 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(join(dataFolder(), 'DLCCoast.esm'), buildTes4Buffer(['Fallout4.esm']));
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Mod.esp\r\n');
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    await writeFile(join(dir, 'mods', 'SomeMod', 'Mod.esp'), buildTes4Buffer([]));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+SomeMod\r\n');

    const rows = await providerFor().getChildren();
    expect(rows.map((r) => r.label)).toEqual(['Fallout4.esm', 'DLCCoast.esm', 'Mod.esp']);
    expect(rows[0]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[1]).toBeInstanceOf(ImplicitMasterNode);
    expect(rows[0].contextValue).toBe('pluginImplicit');
    expect((rows[0] as ImplicitMasterNode).checkboxState).toBeUndefined();
    expect(rows[2]).toBeInstanceOf(PluginNode);
  });

  it('a name in both dataFolder and plugins.txt renders exactly once, as the implicit row (real LitR CC .esl case)', async () => {
    await writeFile(join(dataFolder(), 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(join(dataFolder(), 'ccBGSFO4044-HellfirePowerArmor.esl'), buildTes4Buffer(['Fallout4.esm']));
    // plugins.txt also lists the CC .esl (a stale/redundant entry — real LitR shape).
    await writeFile(
      join(dir, 'profiles', 'Default', 'plugins.txt'),
      'Fallout4.esm\r\n*ccBGSFO4044-HellfirePowerArmor.esl\r\n',
    );

    const rows = await providerFor().getChildren();
    const labels = rows.map((r) => r.label);
    expect(labels.filter((l) => l === 'ccBGSFO4044-HellfirePowerArmor.esl')).toHaveLength(1);
    expect(labels.filter((l) => l === 'Fallout4.esm')).toHaveLength(1);
    expect(rows.find((r) => r.label === 'ccBGSFO4044-HellfirePowerArmor.esl')).toBeInstanceOf(ImplicitMasterNode);
  });

  it('real LitR shape: a mod master declaring Fallout4.esm (present only in dataFolder, absent from plugins.txt) shows no false missing-master badge', async () => {
    await writeFile(join(dataFolder(), 'Fallout4.esm'), buildTes4Buffer([]));
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    await writeFile(join(dir, 'mods', 'SomeMod', 'Mod.esp'), buildTes4Buffer(['Fallout4.esm']));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+SomeMod\r\n');
    // Fallout4.esm has NO line in plugins.txt at all — the bug's exact reproduction.
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Mod.esp\r\n');

    const rows = await providerFor().getChildren();
    const modRow = rows.find((r) => r.label === 'Mod.esp') as PluginNode;
    expect(modRow.iconPath).toBeUndefined();
  });

  it('a master genuinely absent from both Data/ and plugins.txt is still flagged', async () => {
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    await writeFile(join(dir, 'mods', 'SomeMod', 'Mod.esp'), buildTes4Buffer(['NoSuchMaster.esm']));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+SomeMod\r\n');
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Mod.esp\r\n');

    const rows = await providerFor().getChildren();
    const modRow = rows.find((r) => r.label === 'Mod.esp') as PluginNode;
    expect(modRow.iconPath).toEqual({ id: 'error' });
    expect(modRow.tooltip).toContain('NoSuchMaster.esm');
  });

  it('degrades to no implicit rows (logged) when the Data folder is unresolved/unreadable, tree still renders', async () => {
    const logs: string[] = [];
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Mod.esp\r\n');
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    await writeFile(join(dir, 'mods', 'SomeMod', 'Mod.esp'), buildTes4Buffer([]));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+SomeMod\r\n');

    const provider = providerFor({ dataFolder: () => Promise.resolve(join(dir, 'no', 'such', 'Data')), log: (m) => logs.push(m) });
    const rows = await provider.getChildren();

    expect(rows.some((r) => r instanceof ImplicitMasterNode)).toBe(false);
    expect(rows.every((n) => n.kind !== 'error')).toBe(true);
    expect(rows.map((r) => r.label)).toEqual(['Mod.esp']);
  });

  it('handleDrag still filters to only "plugin" nodes, excluding implicit rows for free (no code change needed)', async () => {
    await writeFile(join(dataFolder(), 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '*Mod.esp\r\n');
    await mkdir(join(dir, 'mods', 'SomeMod'), { recursive: true });
    await writeFile(join(dir, 'mods', 'SomeMod', 'Mod.esp'), buildTes4Buffer([]));
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+SomeMod\r\n');

    const provider = providerFor();
    const rows = await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag(rows, dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['Mod.esp']);
  });
});

describe('PluginListProvider — implicit master drop-index mapping (issue #108 drop-index hazard)', () => {
  let dir: string;
  const pluginsTxt = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const dataFolder = () => join(dir, 'Game', 'Data');
  const node = (name: string) => new PluginNode({ name, enabled: true });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-implicit-drop-'));
    await mkdir(dataFolder(), { recursive: true });
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await writeFile(join(dataFolder(), 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(
      join(dir, 'ModOrganizer.ini'),
      `[General]\r\nselected_profile=@ByteArray(Default)\r\ngamePath=@ByteArray(${join(dir, 'Game')})\r\n`,
    );
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '');
    // Raw plugins.txt has NO implicit-master line — Fallout4.esm is purely a
    // synthetic display row. B.esp/C.esp are the real, draggable file rows.
    await writeFile(pluginsTxt(), '*B.esp\r\n*C.esp\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function dragToDisk(moved: string[], target: PluginNode | ImplicitMasterNode | undefined) {
    const source = new Mo2ModlistSource(dir);
    const provider = new PluginListProvider({ source, instanceRoot: dir, dataFolder: () => Promise.resolve(dataFolder()) });
    await provider.getChildren(); // cache the rendered order (raw plugins.txt order — no implicit lines)
    const dt = new FakeDataTransfer();
    provider.handleDrag(moved.map(node), dt as never, NONE);
    await provider.handleDrop(target, dt as never, NONE);
  }

  it('dropping onto the implicit block lands the moved plugin at file-index 0, and the file never gains an implicit-master line', async () => {
    const rows = await new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: () => Promise.resolve(dataFolder()) }).getChildren();
    const implicitRow = rows.find((r): r is ImplicitMasterNode => r instanceof ImplicitMasterNode)!;

    await dragToDisk(['C.esp'], implicitRow);

    const text = await readFile(pluginsTxt(), 'utf8');
    expect(text).toBe('*C.esp\r\n*B.esp\r\n'); // C moved to file-index 0
    expect(text).not.toContain('Fallout4.esm'); // never written into plugins.txt
  });

  it('dropping onto a normal row is unaffected by the implicit prefix — same file index as with no dataFolder/implicit rows at all', async () => {
    await dragToDisk(['C.esp'], node('B.esp'));
    expect(await readFile(pluginsTxt(), 'utf8')).toBe('*C.esp\r\n*B.esp\r\n');

    // Reset and verify the same drop with no dataFolder produces the identical result.
    await writeFile(pluginsTxt(), '*B.esp\r\n*C.esp\r\n');
    const source = new Mo2ModlistSource(dir);
    const provider = new PluginListProvider({ source }); // no instanceRoot/dataFolder — no implicit rows
    await provider.getChildren();
    const dt = new FakeDataTransfer();
    provider.handleDrag(['C.esp'].map(node), dt as never, NONE);
    await provider.handleDrop(node('B.esp'), dt as never, NONE);
    expect(await readFile(pluginsTxt(), 'utf8')).toBe('*C.esp\r\n*B.esp\r\n');
  });
});
