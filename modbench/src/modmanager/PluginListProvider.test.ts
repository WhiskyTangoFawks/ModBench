import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IModlistSource, InstallMeta, ModlistEntry } from './model';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';

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
