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

import { PluginListProvider, PluginNode, ErrorNode, EmptyNode } from './PluginListProvider';

/** Minimal IModlistSource stub: only the two plugin read methods matter here;
 *  everything else throws to prove PluginListProvider never touches them. */
class FakeSource implements IModlistSource {
  setPluginEnabledCalls: { pluginName: string; enabled: boolean }[] = [];
  reorderPluginsCalls: { names: string[]; toIndex: number }[] = [];
  reorderPluginsError?: Error;
  constructor(
    private readonly order: string[] | Error,
    private readonly enabled: string[] = [],
  ) {}
  readPluginOrder(): Promise<string[]> {
    return this.order instanceof Error ? Promise.reject(this.order) : Promise.resolve(this.order);
  }
  readEnabledPlugins(): Promise<string[]> {
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
    const provider = new PluginListProvider(new FakeSource(['A.esp', 'B.esp'], ['B.esp']));
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBeInstanceOf(PluginNode);
    expect(rows[0].label).toBe('A.esp');
    expect((rows[0] as PluginNode).checkboxState).toBe(0); // Unchecked
    expect(rows[1].label).toBe('B.esp');
    expect((rows[1] as PluginNode).checkboxState).toBe(1); // Checked
  });

  it('has no children under a row (flat list)', async () => {
    const provider = new PluginListProvider(new FakeSource(['A.esp'], ['A.esp']));
    const [row] = await provider.getChildren();
    expect(await provider.getChildren(row)).toEqual([]);
  });

  it('renders a single error node when plugins.txt cannot be read', async () => {
    const logged: string[] = [];
    const provider = new PluginListProvider(new FakeSource(new Error('boom')), (m) => logged.push(m));
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(ErrorNode);
    expect(rows[0].tooltip).toBe('boom');
    expect(logged.join('\n')).toContain('boom');
  });

  it('renders a single "No plugins" node when plugins.txt is empty', async () => {
    const provider = new PluginListProvider(new FakeSource([]));
    const rows = await provider.getChildren();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(EmptyNode);
    expect(rows[0].label).toBe('No plugins');
  });

  it('setPluginEnabled delegates to the source and fires a refresh', async () => {
    const source = new FakeSource(['A.esp']);
    const provider = new PluginListProvider(source);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setPluginEnabled('A.esp', false);

    expect(source.setPluginEnabledCalls).toEqual([{ pluginName: 'A.esp', enabled: false }]);
    expect(fired).toBe(true);
  });

  it('refresh() fires onDidChangeTreeData so the Refresh button can re-read', () => {
    const provider = new PluginListProvider(new FakeSource(['A.esp']));
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.refresh();
    expect(fired).toBe(true);
  });
});

describe('PluginListProvider — filter', () => {
  it('narrows rows to plugins whose filename contains the text, case-insensitively', async () => {
    const provider = new PluginListProvider(new FakeSource(['Alpha.esp', 'Beta.esp', 'AlphaExtra.esp']));
    provider.setFilter('ALPHA');
    const rows = await provider.getChildren();

    expect(rows.map((r) => r.label)).toEqual(['Alpha.esp', 'AlphaExtra.esp']);
  });

  it('restores the full list when the filter is cleared', async () => {
    const provider = new PluginListProvider(new FakeSource(['Alpha.esp', 'Beta.esp']));
    provider.setFilter('alpha');
    expect(await provider.getChildren()).toHaveLength(1);

    provider.setFilter('');
    expect((await provider.getChildren()).map((r) => r.label)).toEqual(['Alpha.esp', 'Beta.esp']);
  });

  it('returns an empty list (not the "No plugins" node) when the filter matches nothing', async () => {
    const provider = new PluginListProvider(new FakeSource(['Alpha.esp', 'Beta.esp']));
    provider.setFilter('nomatch');
    const rows = await provider.getChildren();

    expect(rows).toEqual([]);
    expect(rows.some((r) => r instanceof EmptyNode)).toBe(false);
  });

  it('fires onDidChangeTreeData when the filter is set', () => {
    const provider = new PluginListProvider(new FakeSource(['Alpha.esp']));
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });
    provider.setFilter('a');
    expect(fired).toBe(true);
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
    const provider = new PluginListProvider(source, undefined, {
      report: (severity, message) => reports.push({ severity, message }),
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
    const provider = new PluginListProvider(new FakeSource(ORDER));
    const dt = new FakeDataTransfer();
    provider.handleDrag([node('A.esp'), node('C.esp')], dt as never, NONE);
    const item = dt.get('application/vnd.medit.pluginlist-node');
    expect((item?.value as { names: string[] }).names).toEqual(['A.esp', 'C.esp']);
  });

  it('handleDrag ignores non-plugin nodes (Empty/Error) in the selection', () => {
    const provider = new PluginListProvider(new FakeSource(ORDER));
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
    const provider = new PluginListProvider(source);
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
    const provider = new PluginListProvider(source);
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
    const provider = new PluginListProvider(source);
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

  const provider = () => new PluginListProvider(new Mo2ModlistSource(dir), undefined, undefined, dir);

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

  it('checks a vanilla row the same way (no special-casing)', async () => {
    // Base.esp (mod) before Fallout4.esm (vanilla) — Base's vanilla master loads too late.
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Base.esp\r\nFallout4.esm\r\nChild.esp\r\n');
    const nodes = await pluginNodes(provider());
    expect(byName(nodes, 'Base.esp').iconPath).toEqual({ id: 'error' });
    expect(byName(nodes, 'Base.esp').tooltip).toContain('Fallout4.esm');
  });

  it('renders the plain tree (badges degraded) with a warning when status computation fails', async () => {
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), 'Fallout4.esm\r\nChild.esp\r\nBase.esp\r\n');
    const logs: string[] = [];
    const reports: { severity: string; message: string }[] = [];
    // instanceRoot pointed at a *file*, not a directory: readModlist hits ENOTDIR,
    // failing the status pass without failing the plugins.txt read (which uses the real dir).
    const source = new Mo2ModlistSource(dir);
    const provider = new PluginListProvider(source, (m) => logs.push(m), { report: (severity, message) => reports.push({ severity, message }) }, join(dir, 'ModOrganizer.ini'));
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
    const provider = new PluginListProvider(new Mo2ModlistSource(dir), undefined, undefined, dir);
    expect(await provider.resolvePluginPath('Base.esp')).toBe(join(dir, 'mods', 'Provider', 'Base.esp'));
  });

  it('resolves an unmanaged vanilla plugin to the game Data folder', async () => {
    const provider = new PluginListProvider(new Mo2ModlistSource(dir), undefined, undefined, dir);
    expect(await provider.resolvePluginPath('Fallout4.esm')).toBe(join(dir, 'Game', 'Data', 'Fallout4.esm'));
  });

  it('returns undefined without touching the source when no instanceRoot is configured', async () => {
    const source = new FakeSource(['Base.esp']); // readModlist throws if ever called
    const provider = new PluginListProvider(source, undefined, undefined, undefined);
    expect(await provider.resolvePluginPath('Base.esp')).toBeUndefined();
  });

  it('returns undefined and logs (no throw) when resolution fails', async () => {
    const logs: string[] = [];
    // instanceRoot pointed at a *file*: readModlist hits ENOTDIR.
    const provider = new PluginListProvider(new Mo2ModlistSource(dir), (m) => logs.push(m), undefined, join(dir, 'ModOrganizer.ini'));
    expect(await provider.resolvePluginPath('Base.esp')).toBeUndefined();
    expect(logs.some((l) => l.includes('resolvePluginPath'))).toBe(true);
  });
});
