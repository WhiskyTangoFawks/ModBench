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

import {
  PendingChangesTreeProvider,
  PendingLeafNode,
  PendingGroupNode,
  EmptyStateNode,
  ErrorNode,
} from '../PendingChangesTreeProvider';

type Group = {
  id: string;
  operation: string;
  description: string | null;
  changeCount: number;
  pluginCount: number;
};

function group(overrides: Partial<Group> & { id: string }): Group {
  return { operation: 'field_edit', description: null, changeCount: 1, pluginCount: 1, ...overrides };
}

function change(overrides: Partial<any> & { id: string }) {
  return {
    formKey: '001234:MyPatch.esp',
    plugin: 'MyPatch.esp',
    fieldPath: 'Height',
    recordType: 'npc_',
    oldValue: '0.97',
    newValue: '1.05',
    changeType: 'field_edit',
    ...overrides,
  };
}

/** Stub ApiClient. `groups` answers GET /change-groups; `changes` answers the flat
 *  GET /changes; `membersByGroupId` answers GET /changes?groupId={id}. `groupsThrows`/
 *  `changesThrows` reject instead of resolving non-OK — the "request never came back at all"
 *  failure mode, distinct from a non-OK response (#334 review). */
function makeClient(opts: {
  groups?: Group[];
  changes?: any[];
  membersByGroupId?: Record<string, any[]>;
  groupsOk?: boolean;
  changesOk?: boolean;
  groupsThrows?: boolean;
  changesThrows?: boolean;
}) {
  const { groups = [], changes = [], membersByGroupId = {}, groupsOk = true, changesOk = true, groupsThrows = false, changesThrows = false } = opts;
  return {
    GET: vi.fn().mockImplementation((path: string, init?: any) => {
      if (path === '/change-groups') {
        if (groupsThrows) return Promise.reject(new Error('network down'));
        return Promise.resolve({ data: groupsOk ? groups : undefined, response: { ok: groupsOk, status: groupsOk ? 200 : 500 } });
      }
      if (path === '/changes') {
        const gid = init?.params?.query?.groupId;
        if (gid !== undefined) {
          return Promise.resolve({ data: membersByGroupId[gid] ?? [], response: { ok: true, status: 200 } });
        }
        if (changesThrows) return Promise.reject(new Error('network down'));
        return Promise.resolve({ data: changesOk ? changes : undefined, response: { ok: changesOk, status: changesOk ? 200 : 500 } });
      }
      return Promise.resolve({ data: undefined, response: { ok: false, status: 404 } });
    }),
  } as any;
}

describe('PendingChangesTreeProvider — root', () => {
  beforeEach(() => vi.resetAllMocks());

  // ── Slice 7: empty state ──────────────────────────────────────────────────
  it('returns a single EmptyStateNode when there are no groups', async () => {
    const provider = new PendingChangesTreeProvider(makeClient({ groups: [] }), vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyStateNode);
    expect((children[0]).label).toBe('No pending changes.');
  });

  // ── Slice 6: error node on fetch failure ──────────────────────────────────
  it('returns an ErrorNode (not the empty state) when /change-groups fails', async () => {
    const provider = new PendingChangesTreeProvider(makeClient({ groupsOk: false }), vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
    expect(children[0]).not.toBeInstanceOf(EmptyStateNode);
  });

  it('returns an ErrorNode when /changes fails', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changesOk: false });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  // #334 review (Spec axis): a thrown request (network down, no response at all) is a distinct
  // failure mode from a non-OK response, and must render the same ErrorNode rather than propagate
  // out of getChildren() as an unhandled rejection.
  it('returns an ErrorNode, not an unhandled rejection, when the /change-groups request throws', async () => {
    const provider = new PendingChangesTreeProvider(makeClient({ groupsThrows: true }), vi.fn());
    await expect(provider.getChildren()).resolves.toEqual([expect.any(ErrorNode)]);
  });

  it('returns an ErrorNode, not an unhandled rejection, when the /changes request throws', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changesThrows: true });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    await expect(provider.getChildren()).resolves.toEqual([expect.any(ErrorNode)]);
  });

  // ── Slice 1: singleton renders as a top-level leaf ────────────────────────
  it('renders a single field edit as a top-level leaf with record, field, old→new and plugin', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({ id: 'c1', recordType: 'npc_', formKey: '001234:MyPatch.esp', fieldPath: 'Height', oldValue: '0.97', newValue: '1.05', plugin: 'MyPatch.esp' })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect(node).toBeInstanceOf(PendingLeafNode);
    expect((node as PendingLeafNode).label).toBe('npc_ / 001234:MyPatch.esp · Height');
    expect((node as PendingLeafNode).description).toBe('0.97 → 1.05 · MyPatch.esp');
    expect((node as PendingLeafNode).contextValue).toBe('pendingGroup');
    expect((node as PendingLeafNode).collapsibleState).toBe(0);
  });

  // ── Issue #159: leaf label upgrades to EditorID when the change's own FormKey resolves ────
  it('renders the leaf label with the resolved EditorID in place of the raw FormKey', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({
        id: 'c1', recordType: 'npc_', formKey: '001234:MyPatch.esp', fieldPath: 'Height',
        recordResolution: { state: 'ResolvedValidType', recordType: 'npc_', editorId: 'GoodNpc' },
      })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect((node as PendingLeafNode).label).toBe('npc_ / GoodNpc · Height');
  });

  it('falls back to the raw FormKey in the leaf label when the record is unresolved', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({
        id: 'c1', recordType: 'npc_', formKey: '001234:MyPatch.esp', fieldPath: 'Height',
        recordResolution: { state: 'Unresolved', recordType: null, editorId: null },
      })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect((node as PendingLeafNode).label).toBe('npc_ / 001234:MyPatch.esp · Height');
  });

  it('falls back to the raw FormKey in the leaf label when the change carries no recordResolution at all', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({ id: 'c1', recordType: 'npc_', formKey: '001234:MyPatch.esp', fieldPath: 'Height' })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect((node as PendingLeafNode).label).toBe('npc_ / 001234:MyPatch.esp · Height');
  });

  // ── Issue #110: leaf label shows the xEdit display name, not the raw signature ────
  it('renders the leaf label with the xEdit display name in place of the raw record type', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({
        id: 'c1', recordType: 'npc_', recordTypeDisplayName: 'Non-Player Character',
        formKey: '001234:MyPatch.esp', fieldPath: 'Height',
      })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect((node as PendingLeafNode).label).toBe('Non-Player Character / 001234:MyPatch.esp · Height');
  });

  // ── Slice 2: singleton left-click opens its record ────────────────────────
  it('gives a singleton leaf an openEditor command carrying its formKey', async () => {
    const client = makeClient({
      groups: [group({ id: 'c1' })],
      changes: [change({ id: 'c1', formKey: '001234:MyPatch.esp' })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    const cmd = (node as PendingLeafNode).command as any;
    expect(cmd.command).toBe('modbench.openEditor');
    expect(cmd.arguments[0].formKey).toBe('001234:MyPatch.esp');
  });

  // ── Slice 3: multi-member group renders as an expandable header ────────────
  it('renders a multi-member group as one expandable node with operation, description and scope', async () => {
    const client = makeClient({
      groups: [group({ id: 'm1', operation: 'renumber', description: 'NPC_ / Bandit → 001299', changeCount: 7, pluginCount: 2 })],
      membersByGroupId: {
        m1: [
          change({ id: 'm1', formKey: 'A:MyPatch.esp' }),
          change({ id: 'a2', formKey: 'B:MyPatch.esp' }),
          change({ id: 'a3', formKey: 'C:OtherPatch.esp' }),
          change({ id: 'a4', formKey: 'D:OtherPatch.esp' }),
        ],
      },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect(node).toBeInstanceOf(PendingGroupNode);
    expect((node as PendingGroupNode).label).toBe('renumber NPC_ / Bandit → 001299');
    expect((node as PendingGroupNode).description).toBe('7 edits · 4 records · 2 plugins');
    expect((node as PendingGroupNode).collapsibleState).toBe(1);
    expect((node as PendingGroupNode).contextValue).toBe('pendingGroup');
    expect(((node as PendingGroupNode).iconPath as any).id).toBe('link');
  });

  it('labels a multi-member group by operation alone when it has no description', async () => {
    const client = makeClient({
      groups: [group({ id: 'm1', operation: 'delete', description: null, changeCount: 3, pluginCount: 1 })],
      membersByGroupId: { m1: [change({ id: 'm1' }), change({ id: 'x2' }), change({ id: 'x3' })] },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [node] = await provider.getChildren();
    expect((node as PendingGroupNode).label).toBe('delete');
  });

  // ── Slice 5: sort ──────────────────────────────────────────────────────────
  it('sorts multi-member groups above single edits, and single edits by plugin then record', async () => {
    const client = makeClient({
      groups: [
        group({ id: 's1', changeCount: 1 }),
        group({ id: 'm1', operation: 'renumber', changeCount: 2, pluginCount: 1 }),
        group({ id: 's2', changeCount: 1 }),
        group({ id: 's3', changeCount: 1 }),
      ],
      changes: [
        change({ id: 's1', plugin: 'ZPatch.esp', formKey: '000001:ZPatch.esp' }),
        change({ id: 's2', plugin: 'APatch.esp', formKey: '000009:APatch.esp' }),
        change({ id: 's3', plugin: 'APatch.esp', formKey: '000002:APatch.esp' }),
      ],
      membersByGroupId: { m1: [change({ id: 'm1' }), change({ id: 'q2' })] },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const children = await provider.getChildren();
    expect(children[0]).toBeInstanceOf(PendingGroupNode);
    // Then singletons: APatch before ZPatch; within APatch, formKey 000002 before 000009.
    expect((children[1] as PendingLeafNode).formKey).toBe('000002:APatch.esp');
    expect((children[2] as PendingLeafNode).formKey).toBe('000009:APatch.esp');
    expect((children[3] as PendingLeafNode).formKey).toBe('000001:ZPatch.esp');
  });
});

// ── Slice 4: expanding a multi-member group lists its member edits ───────────
describe('PendingChangesTreeProvider — group expansion', () => {
  beforeEach(() => vi.resetAllMocks());

  it('lists member edits as pendingGroupMember leaves that open their record', async () => {
    const client = makeClient({
      groups: [group({ id: 'm1', operation: 'renumber', changeCount: 2, pluginCount: 1 })],
      membersByGroupId: {
        m1: [
          change({ id: 'm1', formKey: 'A:MyPatch.esp', fieldPath: 'EditorID' }),
          change({ id: 'a2', formKey: 'B:MyPatch.esp', fieldPath: 'BoundWeapon' }),
        ],
      },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [groupNode] = await provider.getChildren();
    const members = await provider.getChildren(groupNode);
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m).toBeInstanceOf(PendingLeafNode);
      expect((m as PendingLeafNode).contextValue).toBe('pendingGroupMember');
      expect(((m as PendingLeafNode).command as any).command).toBe('modbench.openEditor');
    }
  });

  it('returns no children for a leaf node', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changes: [change({ id: 'c1' })] });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [leaf] = await provider.getChildren();
    expect(await provider.getChildren(leaf)).toEqual([]);
  });

  // ── Slice 8: getParent ──────────────────────────────────────────────────────
  it('getParent maps a member to its group node and a top-level node to undefined', async () => {
    const client = makeClient({
      groups: [group({ id: 'm1', operation: 'renumber', changeCount: 2, pluginCount: 1 })],
      membersByGroupId: { m1: [change({ id: 'm1' }), change({ id: 'a2' })] },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const [groupNode] = await provider.getChildren();
    const [member] = await provider.getChildren(groupNode);
    expect(provider.getParent(member)).toBe(groupNode);
    expect(provider.getParent(groupNode)).toBeUndefined();
  });
});

// ── Slice 1 (#140): resolve a change id to its node, for click-to-reveal ─────
describe('PendingChangesTreeProvider — resolveChange', () => {
  beforeEach(() => vi.resetAllMocks());

  it('resolves a top-level group-of-one leaf by change id', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changes: [change({ id: 'c1' })] });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const node = await provider.resolveChange('c1');
    expect(node).toBeInstanceOf(PendingLeafNode);
    expect((node as PendingLeafNode).changeId).toBe('c1');
  });

  it('resolves a member node inside a multi-member group, parented to the group', async () => {
    const client = makeClient({
      groups: [group({ id: 'm1', operation: 'renumber', changeCount: 2, pluginCount: 1 })],
      membersByGroupId: { m1: [change({ id: 'm1' }), change({ id: 'a2' })] },
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    const node = await provider.resolveChange('a2');
    expect(node).toBeInstanceOf(PendingLeafNode);
    expect((node as PendingLeafNode).changeId).toBe('a2');
    expect(provider.getParent(node!)).toBeInstanceOf(PendingGroupNode);
  });

  // The "saved or reverted since" case (#140 AC): the change is simply no longer in the
  // pending set. The caller (extension.ts) is expected to no-op on undefined, never throw.
  it('returns undefined for an id that is not pending (already saved or reverted)', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changes: [change({ id: 'c1' })] });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    await expect(provider.resolveChange('stale-id')).resolves.toBeUndefined();
  });

  it('returns undefined when there is nothing pending at all', async () => {
    const provider = new PendingChangesTreeProvider(makeClient({ groups: [] }), vi.fn());
    await expect(provider.resolveChange('anything')).resolves.toBeUndefined();
  });
});

// ── Save All / Revert All gating + the view badge: staged count on every root render ──
// #247: one signal, not two. The count drives both the modbench.hasPendingChanges context key
// (count > 0) and the TreeView badge, so the badge can never disagree with the gating — and the
// badge is what surfaces staged work on the activity-bar icon while the view is collapsed.
describe('PendingChangesTreeProvider — pending-state signal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reports the staged group count when there are groups', async () => {
    const onPendingState = vi.fn();
    const client = makeClient({
      groups: [group({ id: 'c1' }), group({ id: 'c2' })],
      changes: [change({ id: 'c1' }), change({ id: 'c2' })],
    });
    const provider = new PendingChangesTreeProvider(client, vi.fn(), onPendingState);
    await provider.getChildren();
    expect(onPendingState).toHaveBeenLastCalledWith(2);
  });

  it('reports zero when nothing is staged', async () => {
    const onPendingState = vi.fn();
    const provider = new PendingChangesTreeProvider(makeClient({ groups: [] }), vi.fn(), onPendingState);
    await provider.getChildren();
    expect(onPendingState).toHaveBeenLastCalledWith(0);
  });

  it('reports zero when the fetch fails — an unknown count must not read as staged work', async () => {
    const onPendingState = vi.fn();
    const provider = new PendingChangesTreeProvider(makeClient({ groupsOk: false }), vi.fn(), onPendingState);
    await provider.getChildren();
    expect(onPendingState).toHaveBeenLastCalledWith(0);
  });
});

// ── Slice 3 (decision 3 invariant): re-fetch, never trust a cached count ─────
describe('PendingChangesTreeProvider — refresh re-queries', () => {
  beforeEach(() => vi.resetAllMocks());

  it('re-fetches /change-groups on every getChildren call', async () => {
    const client = makeClient({ groups: [group({ id: 'c1' })], changes: [change({ id: 'c1' })] });
    const provider = new PendingChangesTreeProvider(client, vi.fn());
    await provider.getChildren();
    await provider.getChildren();
    const calls = (client.GET).mock.calls.filter((c: any[]) => c[0] === '/change-groups');
    expect(calls).toHaveLength(2);
  });
});
