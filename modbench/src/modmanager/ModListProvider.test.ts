import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IModlistSource, Mod, ModlistEntry, Separator } from './model';
import { parseModlist, moveModInText, moveSeparatorBlockInText } from './mo2/modlistText';
import { buildTes4Buffer } from './test/buildTes4Buffer';

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

import { ModListProvider, CountNode, SeparatorNode, ModNode, ErrorNode } from './ModListProvider';

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
  installMod(_name: string, _dir: string, _meta: unknown): Promise<void> { return Promise.resolve(); }
  reorderSeparatorBlock(_sep: string, _idx: number): Promise<void> { return Promise.resolve(); }
  getNexusSlug(): Promise<string> { return Promise.resolve('fallout4'); }
  listProfiles(): Promise<string[]> { return Promise.resolve(this.profiles); }
  listSeparators(): Promise<string[]> {
    return Promise.resolve(this.entries.filter((e) => e.kind === 'separator').map((e) => e.name));
  }
  getActiveProfile(): Promise<string> { return Promise.resolve(this.activeProfile); }
  setActiveProfile(name: string): Promise<void> { this.activeProfile = name; return Promise.resolve(); }
  readPluginOrder(): Promise<string[]> { return Promise.resolve([]); }
  readEnabledPlugins(): Promise<string[]> { return Promise.resolve([]); }
  setPluginEnabled(): Promise<void> { return Promise.resolve(); }
  reorderPlugins(): Promise<void> { return Promise.resolve(); }
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

  it('renders an error node instead of an empty list when the source read fails', async () => {
    const logs: string[] = [];
    const source = new FakeSource([], /* throwOnRead */ true);
    const provider = new ModListProvider(source, (m) => logs.push(m));

    const roots = await provider.getChildren();

    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeInstanceOf(ErrorNode);
    expect(roots[0].tooltip).toContain('boom');
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

    // Serialise entries to a real modlist.txt so a drop can be observed by its
    // resulting order, not just the pre-removal index argument (issue #76: the
    // suite asserted the argument and so missed the down-drag off-by-one).
    const toModlistText = (entries: ModlistEntry[]): string =>
      entries
        .map((e) => `${e.enabled ? '+' : '-'}${e.name}${e.kind === 'separator' ? '_separator' : ''}`)
        .join('\n') + '\n';

    /** A source that applies real modlist.txt transforms, so tests assert the
     *  final entry order the drop produces end-to-end. */
    class ApplyingSource extends FakeSource {
      text = toModlistText(dndEntries);
      override readModlist(): Promise<ModlistEntry[]> { return Promise.resolve(parseModlist(this.text)); }
      override reorder(name: string, idx: number): Promise<void> { this.text = moveModInText(this.text, name, idx); return Promise.resolve(); }
      override reorderSeparatorBlock(sepName: string, idx: number): Promise<void> { this.text = moveSeparatorBlockInText(this.text, sepName, idx); return Promise.resolve(); }
      order(): string[] { return parseModlist(this.text).map((e) => e.name); }
    }

    function makeApplyingProvider() {
      const source = new ApplyingSource(dndEntries);
      const provider = new ModListProvider(source);
      return { provider, source };
    }

    async function childrenOf(provider: ModListProvider, sepName: string): Promise<ModNode[]> {
      const roots = await provider.getChildren();
      const sepNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode && n.label === sepName)!;
      return (await provider.getChildren(sepNode)) as ModNode[];
    }

    const modItem = (name: string): DragItem => item({ kind: 'mod', name });
    const sepItem = (name: string): DragItem => item({ kind: 'separator', name });
    async function drop(provider: ModListProvider, target: any, payload: DragItem): Promise<void> {
      const dt = new FakeDataTransfer();
      dt.set('application/vnd.medit.modlist-node', payload);
      await provider.handleDrop(target, dt as any, token as any);
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

    // #76 characterization: dragging a mod DOWNWARD (Alpha, above the target,
    // onto Gamma) must land Alpha immediately before Gamma. The old code passed
    // the pre-removal target index, so Alpha landed one slot too low.
    it('down-drag: drop mod onto a lower mod lands it before that mod', async () => {
      const { provider, source } = makeApplyingProvider();
      const gammaNode = (await childrenOf(provider, 'Group A')).find((n) => n.label === 'Gamma')!;
      await drop(provider, gammaNode, modItem('Alpha'));
      expect(source.order()).toEqual(['Group A', 'Beta', 'Alpha', 'Gamma', 'Group B', 'Delta']);
    });

    // Regression: up-drags were never affected (nothing moved sits above the
    // target, so no shift) — must stay correct.
    it('up-drag: drop mod onto a higher mod lands it before that mod', async () => {
      const { provider, source } = makeApplyingProvider();
      const betaNode = (await childrenOf(provider, 'Group A')).find((n) => n.label === 'Beta')!;
      await drop(provider, betaNode, modItem('Delta'));
      expect(source.order()).toEqual(['Alpha', 'Group A', 'Delta', 'Beta', 'Gamma', 'Group B']);
    });

    it('drop mod onto empty space appends it to the end', async () => {
      const { provider, source } = makeApplyingProvider();
      await provider.getChildren(); // populate cache
      await drop(provider, undefined, modItem('Alpha'));
      expect(source.order()).toEqual(['Group A', 'Beta', 'Gamma', 'Group B', 'Delta', 'Alpha']);
    });

    // #76 for separator blocks: the whole block (separator + its children) is
    // removed before toIndex is counted, so every block member above the target
    // shifts it — dragging Group A's block down onto Delta must land the block
    // before Delta, not fling it to the bottom.
    it('down-drag: drop separator block onto a lower mod lands the block before it', async () => {
      const { provider, source } = makeApplyingProvider();
      const deltaNode = (await childrenOf(provider, 'Group B')).find((n) => n.label === 'Delta')!;
      await drop(provider, deltaNode, sepItem('Group A'));
      expect(source.order()).toEqual(['Alpha', 'Group B', 'Group A', 'Beta', 'Gamma', 'Delta']);
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

  describe('sort order toggle', () => {
    it('toggleSortOrder fires a refresh', () => {
      const provider = new ModListProvider(new FakeSource([mod('A')]));
      let fired = false;
      provider.onDidChangeTreeData(() => { fired = true; });

      provider.toggleSortOrder();

      expect(fired).toBe(true);
    });

    it('descending: separators first (reversed), then ungrouped (reversed), count node still pinned first', async () => {
      const source = new FakeSource([
        mod('Ungrouped A'),
        mod('Ungrouped B', false),
        sep('Section 1'),
        mod('Child'),
        sep('Section 2'),
        mod('Other Child'),
      ]);
      const provider = new ModListProvider(source);
      provider.toggleSortOrder();
      const roots = await provider.getChildren();

      expect(roots[0]).toBeInstanceOf(CountNode);
      expect(roots[1]).toBeInstanceOf(SeparatorNode);
      expect(roots[1].label).toBe('Section 2');
      expect(roots[2]).toBeInstanceOf(SeparatorNode);
      expect(roots[2].label).toBe('Section 1');
      expect(roots[3]).toBeInstanceOf(ModNode);
      expect(roots[3].label).toBe('Ungrouped B');
      expect(roots[4]).toBeInstanceOf(ModNode);
      expect(roots[4].label).toBe('Ungrouped A');
    });

    it('descending: mods within a separator are also reversed', async () => {
      const source = new FakeSource([
        sep('Section'),
        mod('First'),
        mod('Second'),
        mod('Third'),
      ]);
      const provider = new ModListProvider(source);
      provider.toggleSortOrder();
      const roots = await provider.getChildren();
      const sepNode = roots.find((n): n is SeparatorNode => n instanceof SeparatorNode)!;
      const children = await provider.getChildren(sepNode);

      expect(children.map((n) => n.label)).toEqual(['Third', 'Second', 'First']);
    });

    it('descending applies to flatFilteredRoots (grouping off)', async () => {
      const entries = [
        mod('Alpha'),
        sep('Group A'),
        mod('Alpha Child'),
        mod('Alpha Other'),
      ] satisfies ModlistEntry[];
      const provider = new ModListProvider(new FakeSource(entries));
      provider.toggleSortOrder();
      provider.setFilter('alpha', false);
      const roots = await provider.getChildren();

      expect(roots.map((n) => n.label)).toEqual(['Alpha Other', 'Alpha Child', 'Alpha']);
    });

    it('descending applies to groupedFilteredRoots (grouping on)', async () => {
      const entries = [
        mod('Alpha'),
        sep('Group A'),
        mod('Alpha Child'),
        mod('Alpha Other'),
      ] satisfies ModlistEntry[];
      const provider = new ModListProvider(new FakeSource(entries));
      provider.toggleSortOrder();
      provider.setFilter('alpha', true);
      const roots = await provider.getChildren();

      expect(roots[0]).toBeInstanceOf(SeparatorNode);
      expect(roots[1]).toBeInstanceOf(ModNode);
      expect(roots[1].label).toBe('Alpha');
      const sepNode = roots[0] as SeparatorNode;
      const children = await provider.getChildren(sepNode);
      expect(children.map((n) => n.label)).toEqual(['Alpha Other', 'Alpha Child']);
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

    it('still shows the mod tree (badges degraded) when status computation fails, instead of an error node', async () => {
      const logs: string[] = [];
      const reports: { severity: string; message: string }[] = [];
      const source = new FakeSource([mod('ModA'), mod('ModB')]);
      // A *file*, not a directory: join(instanceRoot, 'mods', modName) hits ENOTDIR,
      // which modFolderExists/walkMod only swallow for ENOENT — a real, unmocked
      // failure in the status-computation path distinct from a modlist-read failure.
      const brokenInstanceRoot = join(conflictFixture, 'ModOrganizer.ini');
      const reporter = { report: (severity: string, message: string) => reports.push({ severity, message }) };
      const provider = new ModListProvider(source, (m) => logs.push(m), brokenInstanceRoot, reporter);

      const roots = await provider.getChildren();

      expect(roots.some((n) => n instanceof ErrorNode)).toBe(false);
      const modA = roots.find((n): n is ModNode => n instanceof ModNode && n.label === 'ModA')!;
      expect(modA.iconPath).toEqual({ id: 'package' }); // no badge - status computation never completed
      expect(logs.some((l) => l.includes('status computation failed'))).toBe(true);
      // ADR-0026: badges silently missing would otherwise look identical to "no conflicts" — warn the user.
      expect(reports).toEqual([{ severity: 'warning', message: expect.stringContaining('badges may be inaccurate') }]);
    });
  });
});

// The consolidation (#78) threads the game's resolved Data folder from the
// composition root instead of ModListProvider re-reading the ini. This exercises
// that seam end-to-end over a real temp instance: a mod plugin masters a vanilla
// master that lives only in the injected Data folder, so the missing-master badge
// hinges entirely on the dataFolder the provider was handed.
describe('ModListProvider — missing-master badge over the injected game Data folder (#78)', () => {
  let dir: string;
  const modA = (): ModlistEntry => ({ kind: 'mod', name: 'Consumer', enabled: true });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-modlist-datafolder-'));
    await mkdir(join(dir, 'Game', 'Data'), { recursive: true });
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), buildTes4Buffer([]));
    // Consumer ships Child.esp, which masters the vanilla Fallout4.esm (no mod ships it).
    await mkdir(join(dir, 'mods', 'Consumer'), { recursive: true });
    await writeFile(join(dir, 'mods', 'Consumer', 'Child.esp'), buildTes4Buffer(['Fallout4.esm']));
  });
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const modNode = async (provider: ModListProvider): Promise<ModNode> =>
    (await provider.getChildren()).find((n): n is ModNode => n instanceof ModNode && n.label === 'Consumer')!;

  it('resolves the vanilla master from the injected Data folder, so no missing-master badge', async () => {
    const provider = new ModListProvider(new FakeSource([modA()]), undefined, dir, undefined, Promise.resolve(join(dir, 'Game', 'Data')));
    const node = await modNode(provider);
    expect(node.iconPath).toEqual({ id: 'package' }); // Fallout4.esm found → status ok
  });

  it('badges the master as missing when no Data folder is resolved (degraded, empty vanilla set)', async () => {
    const provider = new ModListProvider(new FakeSource([modA()]), undefined, dir); // dataFolder defaults to undefined
    const node = await modNode(provider);
    expect(node.iconPath).toEqual({ id: 'error' }); // Fallout4.esm unresolved → missing master
    expect(node.tooltip).toContain('Missing master: Fallout4.esm');
  });
});
