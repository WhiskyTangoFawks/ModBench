import { describe, it, expect, vi } from 'vitest';
import type { IModlistSource, InstallMeta, ModlistEntry } from './model';

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
}));

import { PluginListProvider, PluginNode, ErrorNode, EmptyNode } from './PluginListProvider';

/** Minimal IModlistSource stub: only the two plugin read methods matter here;
 *  everything else throws to prove PluginListProvider never touches them. */
class FakeSource implements IModlistSource {
  setPluginEnabledCalls: { pluginName: string; enabled: boolean }[] = [];
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
  reorderPlugins(): Promise<void> { throw new Error('unused'); }
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
