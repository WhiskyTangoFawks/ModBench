import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IModlistSource, InstallMeta, ModlistEntry } from './model';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { buildTes4Buffer } from './test/buildTes4Buffer';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    collapsibleState: number;
    checkboxState?: number;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
  EventEmitter: class {
    private readonly handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
  ThemeIcon: class { constructor(public id: string) {} },
  DataTransferItem: class { constructor(public value: unknown) {} },
  DataTransfer: class {
    private readonly map = new Map<string, unknown>();
    set(mime: string, item: unknown) { this.map.set(mime, item); }
    get(mime: string) { return this.map.get(mime); }
  },
}));

import { PluginListProvider, PluginNode, ImplicitMasterNode, ErrorNode, EmptyNode } from './PluginListProvider';

/** Minimal IModlistSource stub: only the two plugin read methods matter here;
 *  everything else throws to prove PluginListProvider never touches them. */
class FakeSource implements IModlistSource {
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
  setEnabled(): Promise<void> { throw new Error('unused'); }
  reorder(): Promise<void> { throw new Error('unused'); }
  insertSeparator(): Promise<void> { throw new Error('unused'); }
  renameSeparator(): Promise<void> { throw new Error('unused'); }
  deleteSeparator(): Promise<void> { throw new Error('unused'); }
  moveModToSeparator(): Promise<void> { throw new Error('unused'); }
  removeMod(): Promise<void> { throw new Error('unused'); }
  installMod(_n: string, _d: string, _m: InstallMeta): Promise<void> { throw new Error('unused'); }
  reorderSeparatorBlock(): Promise<void> { throw new Error('unused'); }
  getNexusSlug(): Promise<string> { throw new Error('unused'); }
  listProfiles(): Promise<string[]> { throw new Error('unused'); }
  listSeparators(): Promise<string[]> { throw new Error('unused'); }
  getActiveProfile(): Promise<string> { throw new Error('unused'); }
  setActiveProfile(): Promise<void> { throw new Error('unused'); }
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

  // Issue #79 asymmetry test: setPluginEnabled must invalidate — the next
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

  it('invalidate() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const provider = new PluginListProvider({ source: new FakeSource(['A.esp']) });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.invalidate();
    expect(fired).toBe(true);
  });

  // Issue #79 asymmetry test: invalidate() clears the cache, so the next
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

  it('fires onDidChangeTreeData when the filter is set', () => {
    const provider = new PluginListProvider({ source: new FakeSource(['Alpha.esp']) });
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setFilter('a');
    expect(fired).toBe(true);
  });

  // Issue #79: a filter keystroke must re-render already-built rows, never
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

  // Mirror of slice 3 (ModListProvider): clearing the filter must restore all
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

  it('surfaces a write failure via the reporter and resyncs the tree (ADR-0026)', async () => {
    const source = new FakeSource(ORDER);
    source.reorderPluginsError = new Error('disk full');
    const { reports, fired } = await drag(source, ['A.esp'], 'D.esp');
    expect(reports).toHaveLength(1);
    expect(reports[0].severity).toBe('error');
    expect(fired).toBe(true); // refresh fired to resync the moved row
  });

  // Issue #79 asymmetry test: a successful drop must invalidate — the next
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
// provider's drag → drop, asserting the on-disk order and byte-faithfulness. This is
// the "round-trip through the tree and the file" the issue asks for (no VS Code process).
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
    new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: Promise.resolve(join(dir, 'Game', 'Data')) });

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

  // Issue #79: same assertion as above, but the filter is set AFTER an initial
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
    // plugins.txt — the check algorithm has no vanilla special-casing; issue #108 fixes
    // the ROW SET (vanilla masters are now an implicit, always-first block), not this
    // per-pair order check, which still flags a genuinely-late real-file master.
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

  it('renders the plain tree (badges degraded) with a warning when status computation fails', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const logs: string[] = [];
    const reports: { severity: string; message: string }[] = [];
    // instanceRoot pointed at a *file*, not a directory: readModlist hits ENOTDIR,
    // failing the status pass without failing the plugins.txt read (which uses the real dir).
    const source = new Mo2ModlistSource(dir);
    const provider = new PluginListProvider({ source, log: (m) => logs.push(m), reporter: { report: (severity, message) => reports.push({ severity, message }) }, instanceRoot: join(dir, 'ModOrganizer.ini') });
    const rows = await provider.getChildren();
    const nodes = rows.filter((n): n is PluginNode => n.kind === 'plugin');

    expect(rows.every((n) => n.kind !== 'error')).toBe(true); // tree still rendered
    expect(byName(nodes, 'Child.esp').iconPath).toBeUndefined(); // no badge — computation failed
    expect(reports).toEqual([{ severity: 'warning', message: expect.stringContaining('master-order status') }]);
    expect(logs.some((l) => l.includes('status'))).toBe(true);
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
    const provider = new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: Promise.resolve(join(dir, 'Game', 'Data')) });
    expect(await provider.resolvePluginPath('Base.esp')).toBe(join(dir, 'mods', 'Provider', 'Base.esp'));
  });

  it('resolves an unmanaged vanilla plugin to the game Data folder', async () => {
    const provider = new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: Promise.resolve(join(dir, 'Game', 'Data')) });
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

// Issue #108: the game's implicitly-loaded vanilla masters (discovered from the
// resolved Data folder — a plugin file that is NOT a hardlink, nlink === 1) render
// as immutable rows ahead of plugins.txt's own lines, so their absence never makes a
// plugin declaring one show a false "missing master".
describe('PluginListProvider — implicit (vanilla) master rows (issue #108)', () => {
  let dir: string;
  const dataFolder = () => join(dir, 'Game', 'Data');
  const providerFor = (extra: Partial<import('./PluginListProvider').PluginListProviderOptions> = {}) =>
    new PluginListProvider({
      source: new Mo2ModlistSource(dir),
      instanceRoot: dir,
      dataFolder: Promise.resolve(dataFolder()),
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

    const provider = providerFor({ dataFolder: Promise.resolve(join(dir, 'no', 'such', 'Data')), log: (m) => logs.push(m) });
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
    const provider = new PluginListProvider({ source, instanceRoot: dir, dataFolder: Promise.resolve(dataFolder()) });
    await provider.getChildren(); // cache the rendered order (raw plugins.txt order — no implicit lines)
    const dt = new FakeDataTransfer();
    provider.handleDrag(moved.map(node), dt as never, NONE);
    await provider.handleDrop(target, dt as never, NONE);
  }

  it('dropping onto the implicit block lands the moved plugin at file-index 0, and the file never gains an implicit-master line', async () => {
    const rows = await new PluginListProvider({ source: new Mo2ModlistSource(dir), instanceRoot: dir, dataFolder: Promise.resolve(dataFolder()) }).getChildren();
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
