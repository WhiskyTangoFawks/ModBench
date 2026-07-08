import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    collapsibleState: number;
    command?: unknown;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach(h => h(e)); }
  },
  ThemeIcon: class { constructor(public id: string) {} },
}));

import { ChangeGroupsTreeProvider, ChangeGroupNode, EmptyStateNode } from '../ChangeGroupsTreeProvider';

function makeGroup(id: string, operation: string, description: string | null, changeCount: number, pluginCount: number) {
  return { id, operation, description, createdAt: new Date().toISOString(), changeCount, pluginCount };
}

function makeClient(groups: ReturnType<typeof makeGroup>[]) {
  return {
    GET: vi.fn().mockResolvedValue({ data: groups, response: { ok: true } }),
  } as any;
}

describe('ChangeGroupsTreeProvider.getChildren (root)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns a single EmptyStateNode when there are no groups', async () => {
    const provider = new ChangeGroupsTreeProvider(makeClient([]), vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyStateNode);
  });

  it('returns one ChangeGroupNode per group', async () => {
    const groups = [makeGroup('g1', 'delete', 'Kill Ghouls', 2, 1), makeGroup('g2', 'renumber', null, 5, 2)];
    const provider = new ChangeGroupsTreeProvider(makeClient(groups), vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children[0]).toBeInstanceOf(ChangeGroupNode);
    expect(children[1]).toBeInstanceOf(ChangeGroupNode);
  });

  it('sets label to operation — description when description is present', async () => {
    const groups = [makeGroup('g1', 'delete', 'Kill Ghouls', 1, 1)];
    const provider = new ChangeGroupsTreeProvider(makeClient(groups), vi.fn());
    const [node] = await provider.getChildren();
    expect((node as ChangeGroupNode).label).toBe('delete — Kill Ghouls');
  });

  it('sets label to operation only when description is null', async () => {
    const groups = [makeGroup('g1', 'renumber', null, 3, 2)];
    const provider = new ChangeGroupsTreeProvider(makeClient(groups), vi.fn());
    const [node] = await provider.getChildren();
    expect((node as ChangeGroupNode).label).toBe('renumber');
  });

  it('sets description to change and plugin counts', async () => {
    const groups = [makeGroup('g1', 'create', null, 4, 3)];
    const provider = new ChangeGroupsTreeProvider(makeClient(groups), vi.fn());
    const [node] = await provider.getChildren();
    expect((node as ChangeGroupNode).description).toBe('4 changes · 3 plugins');
  });

  it('sets contextValue to changeGroup', async () => {
    const groups = [makeGroup('g1', 'delete', null, 1, 1)];
    const provider = new ChangeGroupsTreeProvider(makeClient(groups), vi.fn());
    const [node] = await provider.getChildren();
    expect((node as ChangeGroupNode).contextValue).toBe('changeGroup');
  });

  it('returns EmptyStateNode on fetch error', async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: undefined, response: { ok: false, status: 500 } }) } as any;
    const provider = new ChangeGroupsTreeProvider(client, vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyStateNode);
  });
});

