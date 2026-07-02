import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { IModlistSource, Mod, ModlistEntry, Separator } from './model';

const conflictFixture = join(__dirname, 'test', 'fixtures', 'conflict-instance');

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    collapsibleState: number;
    command?: unknown;
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
    private readonly _items = new Map<string, { value: unknown }>();
    get(mime: string) { return this._items.get(mime); }
    set(mime: string, item: { value: unknown }) { this._items.set(mime, item); }
  },
}));

import { ModListProvider, CountNode, SeparatorNode, ModNode } from './ModListProvider';

const mod = (name: string, enabled = true, extra: Partial<Mod> = {}): Mod => ({
  kind: 'mod', name, enabled, ...extra,
});
const sep = (name: string, enabled = false): Separator => ({ kind: 'separator', name, enabled });

class FakeSource implements IModlistSource {
  setEnabledCalls: { modName: string; enabled: boolean }[] = [];
  activeProfile = 'Default';
  profiles = ['Default', 'Secondary'];
  constructor(public entries: ModlistEntry[], private readonly throwOnRead = false) {}
  readModlist(): Promise<ModlistEntry[]> {
    if (this.throwOnRead) return Promise.reject(new Error('boom'));
    return Promise.resolve(this.entries);
  }
  setEnabled(modName: string, enabled: boolean): Promise<void> {
    this.setEnabledCalls.push({ modName, enabled });
    return Promise.resolve();
  }
  reorder(_name: string, _idx: number): Promise<void> { return Promise.resolve(); }
  insertSeparator(_name: string, _after: string): Promise<void> { return Promise.resolve(); }
  renameSeparator(_old: string, _new: string): Promise<void> { return Promise.resolve(); }
  deleteSeparator(_name: string): Promise<void> { return Promise.resolve(); }
  moveModToSeparator(_mod: string, _sep: string | null): Promise<void> { return Promise.resolve(); }
  removeMod(_name: string): Promise<void> { return Promise.resolve(); }
  reorderSeparatorBlock(_sep: string, _idx: number): Promise<void> { return Promise.resolve(); }
  getNexusSlug(): Promise<string> { return Promise.resolve('fallout4'); }
  listProfiles(): Promise<string[]> { return Promise.resolve(this.profiles); }
  getActiveProfile(): Promise<string> { return Promise.resolve(this.activeProfile); }
  setActiveProfile(name: string): Promise<void> { this.activeProfile = name; return Promise.resolve(); }
  readPluginOrder(): Promise<string[]> { return Promise.resolve([]); }
  readEnabledPlugins(): Promise<string[]> { return Promise.resolve([]); }
}

describe('ModListProvider', () => {
  it('builds root children: count node, ungrouped mods, then separators', async () => {
    const source = new FakeSource([
      mod('Ungrouped A'),
      mod('Ungrouped B', false),
      sep('Section 1'),
      mod('Child'),
    ]);
    const provider = new ModListProvider(source);
    const roots = await provider.getChildren();

    expect(roots[0]).toBeInstanceOf(CountNode);
    expect(roots[0].label).toBe('2 active / 3 installed');
    expect(roots[1]).toBeInstanceOf(ModNode);
    expect(roots[1].label).toBe('Ungrouped A');
    expect(roots[2]).toBeInstanceOf(ModNode);
    expect(roots[2].label).toBe('Ungrouped B');
    expect(roots[3]).toBeInstanceOf(SeparatorNode);
    expect(roots[3].label).toBe('Section 1');
  });

  it('returns a separator’s mods as ModNodes with checkbox, version, tooltip', async () => {
    const source = new FakeSource([
      sep('Section'),
      mod('UFO4P', true, { version: 'v2.1.5', nexusId: '4598', archiveFilename: 'UFO4P.7z' }),
      mod('Disabled Mod', false),
    ]);
    const provider = new ModListProvider(source);
    const roots = await provider.getChildren();
    const separator = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode)!;
    const children = await provider.getChildren(separator);

    expect(children).toHaveLength(2);
    const [enabled, disabled] = children as ModNode[];
    expect(enabled.label).toBe('UFO4P');
    expect(enabled.description).toBe('v2.1.5');
    expect(enabled.checkboxState).toBe(1); // Checked
    expect(enabled.tooltip).toBe('UFO4P · v2.1.5 · 4598 · UFO4P.7z');
    expect(disabled.checkboxState).toBe(0); // Unchecked
    expect(disabled.tooltip).toBe('Disabled Mod'); // no extra fields
  });

  it('setModEnabled delegates to the source and fires a refresh', async () => {
    const source = new FakeSource([mod('A')]);
    const provider = new ModListProvider(source);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.setModEnabled('A', false);

    expect(source.setEnabledCalls).toEqual([{ modName: 'A', enabled: false }]);
    expect(fired).toBe(true);
  });

  it('switchProfile persists the selection and fires a refresh', async () => {
    const source = new FakeSource([mod('A')]);
    const provider = new ModListProvider(source);
    let fired = false;
    provider.onDidChangeTreeData(() => { fired = true; });

    await provider.switchProfile('Secondary');

    expect(source.activeProfile).toBe('Secondary');
    expect(fired).toBe(true);
  });

  it('returns no children and does not throw when the source read fails', async () => {
    const logs: string[] = [];
    const source = new FakeSource([], /* throwOnRead */ true);
    const provider = new ModListProvider(source, (m) => logs.push(m));

    const roots = await provider.getChildren();

    expect(roots).toEqual([]);
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });

  describe('setFilter — grouping on (default)', () => {
    const source = () => new FakeSource([
      mod('Alpha'),
      mod('Beta'),
      sep('Group A'),
      mod('Alpha Child'),
      mod('Gamma'),
      sep('Group B'),
      mod('Delta'),
    ]);

    it('filter with groupingOn hides separators with no matches', async () => {
      const provider = new ModListProvider(source());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      const labels = roots.map((n) => n.label);
      expect(labels).toContain('Alpha');           // ungrouped match
      expect(labels).not.toContain('Beta');         // ungrouped non-match
      expect(labels).toContain('Group A');          // has matching child
      expect(labels).not.toContain('Group B');      // no matches
    });

    it('filter with groupingOn shows only matching children under separator', async () => {
      const provider = new ModListProvider(source());
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();
      const sepNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode)!;
      const children = await provider.getChildren(sepNode);

      expect(children.map((n) => n.label)).toEqual(['Alpha Child']);
    });

    it('separator name match causes all its children to be shown', async () => {
      const provider = new ModListProvider(source());
      provider.setFilter('group a', true);
      const roots = await provider.getChildren();
      const sepNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode)!;
      expect(sepNode.label).toBe('Group A');
      const children = await provider.getChildren(sepNode);
      expect(children.map((n) => n.label)).toEqual(['Alpha Child', 'Gamma']);
    });

    it('fires onDidChangeTreeData when filter is set', () => {
      const provider = new ModListProvider(source());
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });
      provider.setFilter('x', true);
      expect(fired).toBe(true);
    });
  });

  describe('setFilter — grouping off', () => {
    const entries = [
      mod('Alpha'),
      sep('Group A'),
      mod('Alpha Child'),
      mod('Gamma'),
      sep('Group B'),
      mod('Delta'),
    ] satisfies ModlistEntry[];

    it('flat list: only matching mods, no separators, no count', async () => {
      const provider = new ModListProvider(new FakeSource(entries));
      provider.setFilter('alpha', false);
      const roots = await provider.getChildren();

      expect(roots.every((n) => n instanceof ModNode)).toBe(true);
      expect(roots.map((n) => n.label)).toEqual(['Alpha', 'Alpha Child']);
    });
  });

  describe('drag-and-drop', () => {
    type DragItem = { value: unknown };
    class FakeDataTransfer {
      private readonly _items = new Map<string, DragItem>();
      get(mime: string) { return this._items.get(mime); }
      set(mime: string, item: DragItem) { this._items.set(mime, item); }
    }
    const item = (value: unknown): DragItem => ({ value });
    const token = { isCancellationRequested: false };

    const dndEntries: ModlistEntry[] = [
      mod('Alpha'),           // index 0
      sep('Group A'),         // index 1
      mod('Beta'),            // index 2
      mod('Gamma'),           // index 3
      sep('Group B'),         // index 4
      mod('Delta'),           // index 5
    ];

    function makeProvider() {
      const fakeSource = new FakeSource(dndEntries);
      const reorderCalls: { name: string; idx: number }[] = [];
      const moveToSepCalls: { mod: string; sep: string | null }[] = [];
      const reorderBlockCalls: { sep: string; idx: number }[] = [];
      fakeSource.reorder = (name: string, idx: number) => { reorderCalls.push({ name, idx }); return Promise.resolve(); };
      fakeSource.moveModToSeparator = (m: string, s: string | null) => { moveToSepCalls.push({ mod: m, sep: s }); return Promise.resolve(); };
      fakeSource.reorderSeparatorBlock = (s: string, idx: number) => { reorderBlockCalls.push({ sep: s, idx }); return Promise.resolve(); };
      const provider = new ModListProvider(fakeSource);
      return { provider, reorderCalls, moveToSepCalls, reorderBlockCalls };
    }

    it('handleDrag serialises the dragged mod into dataTransfer', async () => {
      const { provider } = makeProvider();
      const roots = await provider.getChildren();
      const alphaNode = roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'Alpha')!;
      const dt = new FakeDataTransfer();
      provider.handleDrag([alphaNode], dt as any, token as any);
      const got = dt.get('application/vnd.medit.modlist-node');
      expect(got?.value).toEqual({ kind: 'mod', name: 'Alpha' });
    });

    it('drop mod onto separator → moveModToSeparator', async () => {
      const { provider, moveToSepCalls } = makeProvider();
      const roots = await provider.getChildren();
      const sepNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === 'Group A')!;
      const dt = new FakeDataTransfer();
      dt.set('application/vnd.medit.modlist-node', item({ kind: 'mod', name: 'Alpha' }));
      await provider.handleDrop(sepNode, dt as any, token as any);
      expect(moveToSepCalls).toEqual([{ mod: 'Alpha', sep: 'Group A' }]);
    });

    it('drop mod onto mod → reorder to target flat index', async () => {
      const { provider, reorderCalls } = makeProvider();
      const roots = await provider.getChildren();
      const groupA = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === 'Group A')!;
      const children = await provider.getChildren(groupA);
      const gammaNode = children.find((n): n is ModNode => n instanceof ModNode && n.label === 'Gamma')!;
      const dt = new FakeDataTransfer();
      dt.set('application/vnd.medit.modlist-node', item({ kind: 'mod', name: 'Alpha' }));
      await provider.handleDrop(gammaNode, dt as any, token as any);
      expect(reorderCalls[0]).toEqual({ name: 'Alpha', idx: 3 }); // Gamma is at flat index 3
    });

    it('drop mod onto undefined → reorder to end', async () => {
      const { provider, reorderCalls } = makeProvider();
      await provider.getChildren(); // populate cache
      const dt = new FakeDataTransfer();
      dt.set('application/vnd.medit.modlist-node', item({ kind: 'mod', name: 'Alpha' }));
      await provider.handleDrop(undefined, dt as any, token as any);
      expect(reorderCalls[0]).toEqual({ name: 'Alpha', idx: dndEntries.length });
    });

    it('drop separator → reorderSeparatorBlock', async () => {
      const { provider, reorderBlockCalls } = makeProvider();
      const roots = await provider.getChildren();
      const groupBNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === 'Group B')!;
      const dt = new FakeDataTransfer();
      dt.set('application/vnd.medit.modlist-node', item({ kind: 'separator', name: 'Group A' }));
      await provider.handleDrop(groupBNode, dt as any, token as any);
      expect(reorderBlockCalls[0]).toEqual({ sep: 'Group A', idx: 4 }); // Group B is at flat index 4
    });
  });

  describe('setFilter — reset behaviour', () => {
    it('clearing filter resets groupingOn to true and shows all nodes', async () => {
      const provider = new ModListProvider(new FakeSource([
        sep('Sep'),
        mod('Mod'),
      ]));
      provider.setFilter('x', false);
      provider.setFilter('', false); // grouping arg ignored when text cleared
      const roots = await provider.getChildren();
      expect(roots.some((n) => n instanceof CountNode)).toBe(true);
      expect(roots.some((n) => n instanceof SeparatorNode)).toBe(true);
    });
  });

  describe('status badges (instanceRoot provided)', () => {
    it('attaches a warning icon and conflict tooltip line to conflicted mods', async () => {
      const source = new FakeSource([mod('ModA'), mod('ModB')]);
      const provider = new ModListProvider(source, undefined, conflictFixture);
      const roots = await provider.getChildren();
      const [modA, modB] = roots.filter((n): n is ModNode => n instanceof ModNode);

      expect(modA.label).toBe('ModA');
      expect(modA.iconPath).toEqual({ id: 'warning' });
      expect(modA.tooltip).toContain('textures/shared/foo.dds');

      expect(modB.label).toBe('ModB');
      expect(modB.iconPath).toEqual({ id: 'warning' });
      expect(modB.tooltip).toContain('textures/shared/foo.dds');
    });

    it('leaves existing no-instanceRoot behaviour unchanged (no status computed)', async () => {
      const source = new FakeSource([mod('ModA'), mod('ModB')]);
      const provider = new ModListProvider(source);
      const roots = await provider.getChildren();
      const modA = roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA')!;

      expect(modA.iconPath).toEqual({ id: 'package' }); // default icon, unaffected by status wiring
    });
  });
});
