import { describe, it, expect, vi } from 'vitest';
import { InMemoryMEditClient, type RecordSummary, type ContainerChildSummary, type RecordPage } from '../../client';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, uriFrom } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon, ThemeColor, Uri: { from: uriFrom },
}));

import {
  PluginTreeProvider, RecordTypeNode, RecordNode,
  CellNode, InteriorCellsNode, InteriorLoadMoreNode,
  WorldspacesNode, WorldspaceNode, SubBlockNode, PlacedGroupNode, PlacedNode,
  headerFormKeyFor,
} from '../PluginTreeProvider';
import { ErrorNode } from '../errorNode';
import type { PluginConditions, PluginTreeNode } from '../PluginTreeProvider';
import { recordResourceUri } from '../recordResourceUri';
import { expectInstanceOf, expectInstanceOfOrUndefined, expectInstancesOf } from '../../test/expectInstanceOf';
import { present } from '../../ports/present';

// ── helpers ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// vscode.Command's own type leaves `arguments` as `any[]`, so this narrows the first one by hand
// instead of an unsafe member access straight off it.
function firstCommandArgument(command: { arguments?: unknown[] } | undefined): Record<string, unknown> {
  const first = command?.arguments?.[0];
  if (!isRecord(first)) throw new Error('expected a command argument object');
  return first;
}

function makeRecord(
  i: number, workingTreeState: RecordSummary['workingTreeState'] = 'None', hasContainerChildren = false,
): RecordSummary {
  return {
    // The backend's real shape — Mutagen's FormKey.ToString(): "<hex6>:<ModKey>".
    formKey: `${String(i).padStart(6, '0')}:Fallout4.esm`,
    plugin: 'Fallout4.esm',
    loadOrderIndex: 0,
    isWinner: true,
    editorId: `Record${i}`,
    origin: 'Data',
    workingTreeState,
    hasContainerChildren,
    hasParseFailure: false,
  };
}

function makeClient(overrides: Partial<{
  recordTypes: { type: string; count: number; displayName?: string; hasParseFailure?: boolean }[];
  records: RecordPage;
}> = {}): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  const recordTypes = overrides.recordTypes ?? [{ type: 'WEAP', count: 5, displayName: 'Weapon' }];
  client.setQueryAnswer('getRecordTypes', recordTypes.map((rt) => ({
    type: rt.type, count: rt.count, displayName: rt.displayName ?? rt.type, hasParseFailure: rt.hasParseFailure ?? false,
  })));
  client.setQueryAnswer('getRecords', overrides.records ?? { items: [makeRecord(0)], total: 1 });
  client.setQueryAnswer('getWorldspaces', []);
  client.setQueryAnswer('getWorldspaceBlocks', { blocks: [], topCells: [] });
  client.setQueryAnswer('getCellReferences', { persistent: [], temporary: [] });
  // A Quest/DialogTopic row's own children — empty by default, overridden per-test below.
  client.setQueryAnswer('getContainerChildren', []);
  client.setQueryAnswer('getInteriorCells', { items: [], total: 0 });
  return client;
}

// getPluginChildren(name) is the one way into a plugin's children — there is no root listing
// (also true in production: PluginsTreeProvider always calls it directly, never
// getChildren(undefined) — see the comment on getChildren itself).

// The merged tree's name filter is covered in PluginsTreeProvider.test.ts — this provider has
// none of its own.

// ── getPluginChildren (record types) ────────────────────────────────────────────

describe('PluginTreeProvider.getPluginChildren (record types)', () => {
  it('returns one RecordTypeNode per record type', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 10 }, { type: 'NPC_', count: 3 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordTypeNode)).toBe(true);
    expect(expectInstanceOf(children[0], RecordTypeNode).recordType).toBe('WEAP');
  });

  it('renders the xEdit display name as the label, not the raw signature', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'acti', count: 10, displayName: 'Activator' }],
    });
    const provider = new PluginTreeProvider(repo);

    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    expect(typeNode.label).toBe('Activator');
    expect(typeNode.recordType).toBe('acti');
  });
});

// ── getChildren(RecordTypeNode) ───────────────────────────────────────────────

describe('PluginTreeProvider.getChildren(RecordTypeNode)', () => {
  it('returns a RecordNode for every record in one call', async () => {
    const records = [makeRecord(0), makeRecord(1), makeRecord(2)];
    const repo = makeClient({ records: { items: records, total: 3 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(3);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
  });

  // Record-type children do not paginate — xEdit's own record-type group nodes load in full
  // (`vstNavInitChildren`, xeMainForm.pas), and measurement found no meaningful cost even at the
  // realistic worst case (~78k INFO rows, ~500ms).
  it('returns every record in one call at a large, realistic-worst-case count — no manual step', async () => {
    const count = 78_089; // Fallout4.esm's own measured INFO count in a full FO4 load order
    const records = Array.from({ length: count }, (_, i) => makeRecord(i));
    const repo = makeClient({ records: { items: records, total: count } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(count);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    // One call, offset 0, and a limit far beyond any page size — the whole type
    // requested up front, not paged.
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls).toContainEqual({ method: 'getRecords', args: ['Plugin0.esp', 'WEAP', 0, expect.any(Number), undefined] });
    const limitArg = present(repo.calls.find(c => c.method === 'getRecords'), 'the getRecords call').args[3];
    if (typeof limitArg !== 'number') throw new Error(`Expected a number, got ${String(limitArg)}`);
    expect(limitArg).toBeGreaterThan(count);
  });

  it('uses cache on second expand without re-fetching', async () => {
    const repo = makeClient({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    await provider.getChildren(typeNode);
    await provider.getChildren(typeNode);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
  });

  // fetchRecords maps each row's own hasContainerChildren straight from the single
  // getRecords response — a "qust" row with none is a leaf, one with some is Collapsed, read from
  // the listing rather than guessed from the record type alone.
  it('a "qust" row\'s collapsible state follows its own RecordSummary.hasContainerChildren, not its record type alone', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'qust', count: 2 }],
      records: {
        items: [
          { ...makeRecord(0, 'None', true), formKey: 'qustWithChildren:Fallout4.esm' },
          { ...makeRecord(1, 'None', false), formKey: 'qustWithoutChildren:Fallout4.esm' },
        ],
        total: 2,
      },
    });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = expectInstancesOf(await provider.getChildren(typeNode), RecordNode);

    const withChildren = present(children.find(c => c.record.formKey === 'qustWithChildren:Fallout4.esm'), 'the qustWithChildren row');
    const withoutChildren = present(children.find(c => c.record.formKey === 'qustWithoutChildren:Fallout4.esm'), 'the qustWithoutChildren row');
    expect(withChildren.collapsibleState).toBe(1); // Collapsed
    expect(withoutChildren.collapsibleState).toBe(0); // None
  });
});

// A per-row `getContainerChildren` fan-out was rejected on cost: up to ~1,300 concurrent round
// trips for one "expand all Quests" on Fallout4.esm. Presence travels inside the single
// getRecords response instead, so no extra repository calls.
describe('PluginTreeProvider.getChildren(RecordTypeNode) — no per-row fan-out for container presence', () => {
  it('listing ~1,300 Quests issues exactly one getRecords call and zero getContainerChildren calls', async () => {
    const count = 1_300; // Fallout4.esm's own approximate QUST count
    const records = Array.from(
      { length: count }, (_, i) => makeRecord(i, 'None', i % 2 === 0));
    const repo = makeClient({ recordTypes: [{ type: 'qust', count }], records: { items: records, total: count } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const children = await provider.getChildren(typeNode);

    expect(children).toHaveLength(count);
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
    expect(repo.calls.some(c => c.method === 'getContainerChildren')).toBe(false);
  });
});

// ── loadMoreInterior ────────────────────────────────────────────────────────

describe('PluginTreeProvider.loadMoreInterior', () => {
  it('renders an ErrorNode alongside the retry affordance when a page fetch fails, preserving already-loaded items', async () => {
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }];
    const repo = makeClient();
    repo.setQueryAnswerOnce('getInteriorCells', { items: firstPage, total: 2 });
    repo.setQueryFailureOnce('getInteriorCells', new Error('boom'));

    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp', 'Cell', 0);
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = expectInstanceOf(firstChildren.find(c => c instanceof InteriorLoadMoreNode), InteriorLoadMoreNode);

    await provider.loadMore(loadMoreNode);
    const afterFailure = await provider.getChildren(node);

    expect(afterFailure.filter(c => c instanceof CellNode)).toHaveLength(1);
    expect(afterFailure.find(c => c instanceof InteriorLoadMoreNode)).toBeDefined();
    const errorNode = present(afterFailure.find(c => c instanceof ErrorNode), 'the ErrorNode after the failed retry');
    expect(errorNode.tooltip).toContain('boom');
  });

  it('clears the ErrorNode on a successful retry', async () => {
    const firstPage = [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }];
    const secondPage = [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }];
    const repo = makeClient();
    repo.setQueryAnswerOnce('getInteriorCells', { items: firstPage, total: 2 });
    repo.setQueryFailureOnce('getInteriorCells', new Error('boom'));
    repo.setQueryAnswerOnce('getInteriorCells', { items: secondPage, total: 2 });

    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp', 'Cell', 0);
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = expectInstanceOf(firstChildren.find(c => c instanceof InteriorLoadMoreNode), InteriorLoadMoreNode);

    await provider.loadMore(loadMoreNode);
    await provider.loadMore(loadMoreNode);
    const afterRetry = await provider.getChildren(node);

    expect(afterRetry.filter(c => c instanceof CellNode)).toHaveLength(2);
    expect(afterRetry.find(c => c instanceof InteriorLoadMoreNode)).toBeUndefined();
    expect(afterRetry.find(c => c instanceof ErrorNode)).toBeUndefined();
  });
});

// The merged tree's plugin rows (contextValue "plugin"/"pluginImplicit", lock icon absent —
// see plugins.md) are covered in PluginsTreeProvider.test.ts; this provider has no plugin-row
// node of its own.

// ── WorldspacesNode ───────────────────────────────────────────────────────────

describe('WorldspacesNode', () => {
  it('has no icon, so it sorts alphabetically alongside icon-less record-type nodes', () => {
    const node = new WorldspacesNode('M.esp', 'Worldspace', 0);
    expect(node.iconPath).toBeUndefined();
  });
});

// ── InteriorCellsNode ─────────────────────────────────────────────────────────

describe('InteriorCellsNode', () => {
  it('has no icon, so it sorts alphabetically alongside icon-less record-type nodes', () => {
    const node = new InteriorCellsNode('M.esp', 'Cell', 0);
    expect(node.iconPath).toBeUndefined();
  });
});

// ── RecordTypeNode ────────────────────────────────────────────────────────────

describe('RecordTypeNode', () => {
  it('uses record type as label when no display name is given', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 42);
    expect(node.label).toBe('WEAP');
  });

  it('uses the xEdit display name as label, keeping recordType as the raw signature', () => {
    // The tree must show "Weapon", not "weap" — but recordType (used for
    // caching, commands, contextValue) stays the raw signature.
    const node = new RecordTypeNode('MyPlugin.esp', 'weap', 42, 'Weapon');
    expect(node.label).toBe('Weapon');
    expect(node.recordType).toBe('weap');
  });

  it('shows formatted count as description', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 1234);
    expect(node.description).toBe('1,234');
  });

  it('states no record edit when no one has described its plugin', () => {
    const node = new RecordTypeNode('MyPlugin.esp', 'WEAP', 10);
    expect(node.contextValue).toBe('recordType untracked');
  });
});

// Record-type children load in one getChildren call (see the large-count test above); only
// interior-cell listing paginates (InteriorLoadMoreNode; see its own tests further down).

// ── RecordNode ────────────────────────────────────────────────────────────────

describe('RecordNode', () => {
  it('wires .command to modbench.openEditor with formKey and label', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record);

    expect(node.command).toEqual({
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: record.formKey, label: record.editorId }],
    });
  });

  it('uses formKey alone as label when editorId is absent', () => {
    const record: RecordSummary = { ...makeRecord(0), editorId: null };
    const node = new RecordNode(record);

    expect(firstCommandArgument(node.command).label).toBe(record.formKey);
  });

  it('states a record of a tracked plugin', () => {
    const node = new RecordNode(makeRecord(0), undefined, { tracked: true, editable: true });
    expect(node.contextValue).toBe('record tracked editable');
  });

  it('states a record of an untracked plugin', () => {
    const node = new RecordNode(makeRecord(0), undefined, { tracked: false, editable: true });
    expect(node.contextValue).toBe('record untracked editable');
  });

  // plugins.md, Menus and keys: the record menu is the same on every record row, an override's too.
  it('states an override as it states the plugin\'s own records', () => {
    const record: RecordSummary = { ...makeRecord(0), plugin: 'PatchMod.esp' };
    expect(new RecordNode(record, undefined, { tracked: false, editable: true }).contextValue).toBe('record untracked editable');
    expect(new RecordNode(record, undefined, { tracked: true, editable: true }).contextValue).toBe('record tracked editable');
  });

  it('states a record of an immutable plugin read-only', () => {
    const node = new RecordNode(makeRecord(0), undefined, { tracked: false, editable: false });
    expect(node.contextValue).toBe('record untracked');
  });

  it('states no record edit when no one has described its plugin', () => {
    expect(new RecordNode(makeRecord(0)).contextValue).toBe('record untracked');
  });

  // resourceUri is what RecordDecorationProvider keys its badge lookup on — carries the same
  // (plugin, origin, formKey) identity ADR-0012 already requires everywhere a record row is
  // addressed, via the synthetic medit-record: scheme (recordResourceUri.ts).
  it('carries a medit-record: resourceUri identifying (plugin, origin, formKey)', () => {
    const record = makeRecord(0);
    const node = new RecordNode(record, 'ModA');

    expect(node.resourceUri).toEqual(recordResourceUri(record.plugin, 'ModA', record.formKey));
  });
});

// ── a field edit flips a cached row's badge without a refetch ─────────────────
// A rival that calls refreshTree() wholesale fails the no-refetch assertion.

describe('markWorkingTreeState / workingTreeStateOf (scoped, no refetch)', () => {
  it('flips a cached clean record to Modified without calling getRecords again', async () => {
    const record = makeRecord(0, 'None');
    const repo = makeClient({ records: { items: [record], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Fallout4.esm', 'ModA'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(typeNode); // populates the page cache
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);

    const changed = provider.markWorkingTreeState('Fallout4.esm', 'ModA', record.formKey, 'Modified');

    expect(changed).toBe(true);
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', record.formKey)).toBe('Modified');
    // The rival this guards: a fix that re-fetches (or clears the cache and lets the next redraw
    // re-fetch) instead of patching in place would show a second call here.
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);

    const [rec] = await provider.getChildren(typeNode);
    expect(expectInstanceOf(rec, RecordNode).record.workingTreeState).toBe('Modified');
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
  });

  it('workingTreeStateOf is undefined for a record nothing has cached yet', () => {
    const provider = new PluginTreeProvider(makeClient());
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', '000001:Fallout4.esm')).toBeUndefined();
  });

  it('markWorkingTreeState returns false, and touches nothing, for an uncached record', () => {
    const provider = new PluginTreeProvider(makeClient());
    expect(provider.markWorkingTreeState('Fallout4.esm', 'ModA', '000001:Fallout4.esm', 'Modified')).toBe(false);
  });

  // A create never seeds records_committed, so a field edit on an Added row must never downgrade
  // it to Modified — that would misrepresent a committed counterpart existing. The rival, an
  // unconditional overwrite with no current-state check, fails this.
  it('preserves Added across a field edit — create, then edit, still badges A', async () => {
    const record = makeRecord(0, 'Added');
    const repo = makeClient({ records: { items: [record], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Fallout4.esm', 'ModA'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(typeNode);

    const changed = provider.markWorkingTreeState('Fallout4.esm', 'ModA', record.formKey, 'Modified');

    expect(changed).toBe(true);
    expect(provider.workingTreeStateOf('Fallout4.esm', 'ModA', record.formKey)).toBe('Added');
  });
});

// ── record rows carry their copy identity ─────────────────────────────────────
// A record-scoped command acts on the clicked row's own copy, so the row says which copy it is
// ((plugin, origin), ADR-0012); rows whose plugin cannot be edited hide Remove.

// plugins.md, Menus and keys: the record menu is on worldspaces, cells and placed references too,
// so each states its record as the record gestures read one: FormKey, EditorID, plugin and origin.
describe('worldspace, cell and placed rows state their record', () => {
  it.each([
    ['worldspace', new WorldspaceNode('A.esp', { formKey: '000801:A.esp', editorId: 'World', hasParseFailure: false }, 'ModA')],
    ['cell', new CellNode('A.esp', {
      formKey: '000801:A.esp', editorId: 'World', cellX: 1, cellY: 2, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false,
    }, 'ModA')],
    ['placed', new PlacedNode('A.esp', {
      formKey: '000801:A.esp', editorId: 'World', baseFormKey: null, recordType: 'refr', hasParseFailure: false,
    }, 'ModA')],
  ])('a %s row', (_kind, node) => {
    expect({ formKey: node.formKey, editorId: node.editorId, plugin: node.plugin, origin: node.origin })
      .toEqual({ formKey: '000801:A.esp', editorId: 'World', plugin: 'A.esp', origin: 'ModA' });
  });

  it('states no EditorID for a record that has none', () => {
    const node = new PlacedNode('A.esp', { formKey: '000801:A.esp', editorId: null, baseFormKey: '000802:A.esp', recordType: 'refr', hasParseFailure: false });
    expect(node.editorId).toBeUndefined();
  });
});

describe('record rows carry their copy identity', () => {
  it('RecordNode carries the browsed origin, threaded from its RecordTypeNode', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp', 'ModA'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const [rec] = await provider.getChildren(typeNode);

    expect(expectInstanceOf(rec, RecordNode).origin).toBe('ModA');
  });

  it('record rows of a plugin outside the load order are read-only, whatever its row states', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(
      await provider.getPluginChildren('Plugin0.esp', 'ModA', { tracked: false, editable: true }), RecordTypeNode,
    )[0], 'the sole RecordTypeNode');

    const [rec] = await provider.getChildren(typeNode);

    expect(expectInstanceOf(rec, RecordNode).contextValue).toBe('record untracked');
  });
});

// plugins.md, Menus and keys: every row beneath a plugin states that plugin's conditions, which
// its plugin row hands down as it expands (ADR-0012: never looked up by filename alone).
describe('a plugin\'s conditions reach every row beneath it', () => {
  const TRACKED: PluginConditions = { tracked: true, editable: true };
  const cell = {
    formKey: '000002:Plugin0.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false,
  };
  const placed = { formKey: '000003:Plugin0.esp', editorId: 'ref', baseFormKey: null, recordType: 'refr', hasParseFailure: false };

  function spatialClient(): InMemoryMEditClient {
    const repo = makeClient({
      recordTypes: [{ type: 'WEAP', count: 1 }, { type: 'wrld', count: 1 }, { type: 'cell', count: 1 }],
    });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: '000001:Plugin0.esp', editorId: 'World', hasParseFailure: false }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [cell],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [cell] }] }],
    });
    repo.setQueryAnswer('getInteriorCells', { items: [cell], total: 1 });
    repo.setQueryAnswer('getCellReferences', { persistent: [placed], temporary: [placed] });
    return repo;
  }

  // Every record row a plugin row expands into, at every depth, by its contextValue.
  async function rowsBeneath(provider: PluginTreeProvider, origin: string | undefined, pluginRowConditions: PluginConditions): Promise<string[]> {
    const states: string[] = [];
    const walk = async (nodes: readonly PluginTreeNode[]): Promise<void> => {
      for (const node of nodes) {
        if (['recordType', 'worldspace', 'cell', 'placed'].includes(node.kind)) states.push(String(node.contextValue));
        if (node.kind !== 'recordType' && node.kind !== 'placed') await walk(await provider.getChildren(node));
      }
    };
    await walk(await provider.getPluginChildren('Plugin0.esp', origin, pluginRowConditions));
    return states;
  }

  it('states a tracked, editable plugin on its group, worldspace, cells and placed references', async () => {
    const states = await rowsBeneath(new PluginTreeProvider(spatialClient()), undefined, TRACKED);

    expect(states).toEqual([
      'recordType tracked editable',
      'worldspace tracked editable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
      'cell tracked editable', 'placed tracked editable', 'placed tracked editable',
    ]);
  });

  it('states a plugin outside the load order read-only, whatever it is told', async () => {
    const states = await rowsBeneath(new PluginTreeProvider(spatialClient()), 'ModA', TRACKED);

    expect(new Set(states.map((state) => state.split(' ').slice(1).join(' ')))).toEqual(new Set(['tracked']));
  });

  async function questAndItsTopic(pluginRowConditions: PluginConditions): Promise<[RecordNode, RecordNode]> {
    const repo = makeClient({
      recordTypes: [{ type: 'qust', count: 1, displayName: 'Quest' }],
      records: { items: [{ ...makeRecord(0, 'None', true), formKey: 'qust1:Fallout4.esm' }], total: 1 },
    });
    repo.setQueryAnswer('getContainerChildren', [makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA')]);
    const provider = new PluginTreeProvider(repo);
    const [group] = await provider.getPluginChildren('Fallout4.esm', undefined, pluginRowConditions);
    const [quest] = await provider.getChildren(present(group, 'the Quest group'));
    const [topic] = await provider.getChildren(present(quest, 'the quest'));
    return [expectInstanceOf(quest, RecordNode), expectInstanceOf(topic, RecordNode)];
  }

  it("states a tracked, editable plugin on a group's records and a quest's children", async () => {
    const [quest, topic] = await questAndItsTopic(TRACKED);

    expect(quest.contextValue).toBe('record tracked editable');
    expect(topic.contextValue).toBe('record tracked editable');
  });

  it("states an untracked, read-only plugin on a group's records and a quest's children", async () => {
    const [quest, topic] = await questAndItsTopic({ tracked: false, editable: false });

    expect(quest.contextValue).toBe('record untracked');
    expect(topic.contextValue).toBe('record untracked');
  });
});

// ── refresh ───────────────────────────────────────────────────────────────────

describe('PluginTreeProvider.refresh', () => {
  it('clears cache so next getChildren re-fetches', async () => {
    const repo = makeClient({ records: { items: [makeRecord(0)], total: 1 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    await provider.getChildren(typeNode);  // fills cache
    provider.refresh();
    await provider.getChildren(typeNode);  // should re-fetch

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(2);
  });

  it('fires onDidChangeTreeData', () => {
    const provider = new PluginTreeProvider(makeClient());

    const fired: unknown[] = [];
    provider.onDidChangeTreeData(e => fired.push(e));
    provider.refresh();

    expect(fired).toHaveLength(1);
  });
});

// ── Worldspace / cell / placed-object tree ──────────────────────────

describe('PluginTreeProvider worldspace tree', () => {
  it('leaves placed references out of the groups, since they sit beneath their cells', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'cell', count: 4, displayName: 'Cell' },
        { type: 'achr', count: 12, displayName: 'Placed NPC' },
        { type: 'refr', count: 99, displayName: 'Placed Object' },
        { type: 'WEAP', count: 5, displayName: 'Weapon' },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children.map(c => c.label)).toEqual(['Cell', 'Weapon']);
  });

  it('expands a worldspace into its persistent cell and blocks, labeled the way xEdit does', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasParseFailure: false }],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasParseFailure: false }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);
    const [topCellNode, blockNode] = wsChildren;
    const subBlocks = await provider.getChildren(blockNode);
    const cells = await provider.getChildren(subBlocks[0]);

    expect(wsChildren).toHaveLength(2); // persistent cell + 1 block
    expect(present(topCellNode, 'the persistent-cell child').label).toBe('TopCell');
    expect(present(blockNode, 'the block child').label).toBe('Block 0, 0');
    expect(present(subBlocks[0], "the fixture's single sub-block").label).toBe('Sub-Block 0, 0');
    expect(expectInstanceOf(cells[0], CellNode).cell.cellX).toBe(12);
    // xEdit's StrRight right-justifies each coordinate to width 3 inside the angle brackets.
    expect(present(cells[0], "the fixture's single cell").label).toBe('< 12,  -5>');
  });

  it('surfaces every block-less cell row under a worldspace, not just the first', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }] });
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false }]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [
        { formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasParseFailure: false },
        { formKey: 'stray:M.esp', editorId: 'StrayCell', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasParseFailure: false },
      ],
      blocks: [],
    });
    const provider = new PluginTreeProvider(repo);
    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [wsNode] = await provider.getChildren(wsRoot);

    const wsChildren = await provider.getChildren(wsNode);

    expect(wsChildren.filter(c => c instanceof CellNode)).toHaveLength(2);
    expect(present(wsChildren[0], 'the first cell row').label).toBe('TopCell');
    expect(present(wsChildren[1], 'the second cell row').label).toBe('StrayCell');
  });

  it('expands a cell into non-empty persistent/temporary groups and placed leaves', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellReferences', {
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const cellNode = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false });

    const groups = await provider.getChildren(cellNode);
    expect(groups).toHaveLength(1); // only persistent (temporary empty)
    const persistentGroup = present(groups[0], 'the sole group');
    expect(persistentGroup.label).toBe('Persistent');

    const placed = await provider.getChildren(persistentGroup);
    expect(placed).toHaveLength(1);
    expect(present(placed[0], 'the sole placed row').label).toBe('barrelRef');
  });

  it('paginates interior cells with a load-more node', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getInteriorCells', {
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }],
      total: 60,
    });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp', 'Cell', 0);

    const children = await provider.getChildren(node);
    expect(children.filter(c => c instanceof CellNode)).toHaveLength(1);
    expect(children.filter(c => c instanceof InteriorLoadMoreNode)).toHaveLength(1);
  });
});

// ── Fetch failures render an error node instead of an empty list (ADR-0019) ──

describe('PluginTreeProvider fetch failures', () => {
  // The merged Plugins tree's rows are Mod Management's, not this provider's, so it needs a
  // way in that starts from a plugin filename rather than from a PluginNode this provider built.
  it('getPluginChildren: builds a plugin\'s children from its filename alone', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'cell', count: 4, displayName: 'Cell' },
        { type: 'WEAP', count: 5, displayName: 'Weapon' },
        { type: 'wrld', count: 1, displayName: 'Worldspace' },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    // Origin rides along as undefined for an ordinary load-order row — the backend resolves
    // it from the load order, where one filename names one plugin.
    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: ['Plugin0.esp', undefined] });
    expect(children.map(c => c.label)).toEqual(['Cell', 'Weapon', 'Worldspace']);
  });

  // A record reached by expanding a load-order row is the same node carrying its own command, so
  // the merged tree inherits the open-editor behaviour rather than re-implementing it.
  it('getPluginChildren: records below it carry the open-editor command', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);
    const [recordType] = await provider.getPluginChildren('Plugin0.esp');

    const [record] = await provider.getChildren(recordType);

    expect(expectInstanceOf(record, RecordNode).command).toMatchObject({ command: 'modbench.openEditor' });
  });

  it('getPluginChildren: renders an error node when getRecordTypes fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getRecordTypes', new Error('boom'));
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchRecords: renders an error node when getRecords fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getRecords', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new RecordTypeNode('Plugin0.esp', 'WEAP', 5);

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaces: renders an error node when getWorldspaces fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getWorldspaces', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspacesNode('Plugin0.esp', 'Worldspace', 0);

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchWorldspaceChildren: renders an error node when getWorldspaceBlocks fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getWorldspaceBlocks', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Plugin0.esp', { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false });

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchCellGroups: renders an error node when getCellReferences fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getCellReferences', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('M.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false });

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('fetchInteriorCells: renders an error node when getInteriorCells fails', async () => {
    const repo = makeClient();
    repo.setQueryFailure('getInteriorCells', new Error('boom'));
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('M.esp', 'Cell', 0);

    const children = await provider.getChildren(node);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });
});

// ── headerFormKeyFor ───────────────────────────────────────────────────────────

describe('headerFormKeyFor', () => {
  it('builds the synthetic header FormKey for a plugin name', () => {
    expect(headerFormKeyFor('Fallout4.esm')).toBe('000000:Fallout4.esm');
  });

  it('uses the plugin name verbatim, including its extension', () => {
    expect(headerFormKeyFor('MyPatch.esp')).toBe('000000:MyPatch.esp');
  });
});

// ── spatial node chain carries origin (ADR-0012) ───────────────────────────────
// Every node in the chain must carry the origin its row was built with, or a deep node silently
// reverts to browsing the load-order winner instead of the plugin the user opened.

describe('PluginTreeProvider spatial origin threading', () => {
  it('fetchWorldspaces: asks the repository for the node\'s own plugin, and the WorldspaceNodes it builds carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getWorldspaces', [{ formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false }]);
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspacesNode('Shared.esp', 'Worldspace', 0, 'ModB');

    const wsNode = present(expectInstancesOf(await provider.getChildren(node), WorldspaceNode)[0], 'the sole WorldspaceNode');

    expect(repo.calls).toContainEqual({ method: 'getWorldspaces', args: ['Shared.esp', 'ModB'] });
    expect(wsNode.origin).toBe('ModB');
  });

  it('fetchWorldspaceChildren: asks the repository for the node\'s own plugin, and its TopCell/Block children carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [{ formKey: 'top:M.esp', editorId: 'TopCell', cellX: null, cellY: null, isPersistentWorldspaceCell: true, hasParseFailure: false }],
      blocks: [{ x: 0, y: 0, hasParseFailure: false, subBlocks: [{ x: 0, y: 0, hasParseFailure: false, cells: [{ formKey: 'c:M.esp', editorId: 'Cell', cellX: 12, cellY: -5, isPersistentWorldspaceCell: false, hasParseFailure: false }] }] }],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new WorldspaceNode('Shared.esp', { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: false }, 'ModB');

    const worldspaceChildren = await provider.getChildren(node);
    const topCellNode = expectInstanceOf(worldspaceChildren[0], CellNode);
    const blockNode = worldspaceChildren[1];

    expect(repo.calls).toContainEqual({ method: 'getWorldspaceBlocks', args: ['Shared.esp', 'wrld:M.esp', 'ModB'] });
    expect(topCellNode.origin).toBe('ModB');

    const [subBlockNode] = await provider.getChildren(blockNode);
    const cellNode = present(expectInstancesOf(await provider.getChildren(subBlockNode), CellNode)[0], 'the sole CellNode');
    expect(expectInstanceOf(subBlockNode, SubBlockNode).origin).toBe('ModB');
    expect(cellNode.origin).toBe('ModB');
  });

  it('fetchCellGroups: asks the repository for the node\'s own plugin, and its PlacedGroup/Placed children carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getCellReferences', {
      persistent: [{ formKey: 'b:M.esp', editorId: 'barrelRef', baseFormKey: null, recordType: 'refr', hasParseFailure: false }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);
    const node = new CellNode('Shared.esp', { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false }, 'ModB');

    const groupNode = present(expectInstancesOf(await provider.getChildren(node), PlacedGroupNode)[0], 'the sole PlacedGroupNode');
    expect(repo.calls).toContainEqual({ method: 'getCellReferences', args: ['Shared.esp', 'c:M.esp', 'ModB'] });
    expect(groupNode.origin).toBe('ModB');

    const placedNode = present(expectInstancesOf(await provider.getChildren(groupNode), PlacedNode)[0], 'the sole PlacedNode');
    expect(placedNode.origin).toBe('ModB');
  });

  it('fetchInteriorCells: asks the repository for the node\'s own plugin, and the CellNodes it builds carry that origin forward', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getInteriorCells', {
      items: [{ formKey: 'i:M.esp', editorId: 'IntCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }],
      total: 1,
    });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('Shared.esp', 'Cell', 0, 'ModB');

    const cellNode = present(expectInstancesOf(await provider.getChildren(node), CellNode)[0], 'the sole CellNode');

    expect(repo.calls).toContainEqual({ method: 'getInteriorCells', args: ['Shared.esp', 0, 50, 'ModB'] });
    expect(cellNode.origin).toBe('ModB');
  });

  // refCache/interiorCache must be keyed by (origin, plugin) like pageCache — a key on plugin
  // alone serves one plugin's pages under the other plugin's node, invisible when only one plugin
  // of that filename loads.
  it('refCache: caches each plugin\'s cell references separately, so one plugin\'s page is never served for the other', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const cell = { formKey: 'c:M.esp', editorId: 'TheCell', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, fullName: null, hasParseFailure: false };
    const fromA = new CellNode('Shared.esp', cell, 'ModA');
    const fromB = new CellNode('Shared.esp', cell, 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getCellReferences')).toHaveLength(2);
  });

  it('interiorCache: caches each plugin\'s interior-cell page separately, so one plugin\'s page is never served for the other', async () => {
    const repo = makeClient();
    const provider = new PluginTreeProvider(repo);
    const fromA = new InteriorCellsNode('Shared.esp', 'Cell', 0, 'ModA');
    const fromB = new InteriorCellsNode('Shared.esp', 'Cell', 0, 'ModB');

    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    expect(repo.calls.filter(c => c.method === 'getInteriorCells')).toHaveLength(2);
  });

  it('loadMoreInterior: keeps asking the repository for the node\'s own plugin on the next page', async () => {
    const repo = makeClient();
    repo.setQueryAnswerOnce('getInteriorCells', { items: [{ formKey: 'i0:M.esp', editorId: 'IntCell0', cellX: 0, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }], total: 2 });
    repo.setQueryAnswerOnce('getInteriorCells', { items: [{ formKey: 'i1:M.esp', editorId: 'IntCell1', cellX: 1, cellY: 0, isPersistentWorldspaceCell: false, hasParseFailure: false }], total: 2 });
    const provider = new PluginTreeProvider(repo);
    const node = new InteriorCellsNode('Shared.esp', 'Cell', 0, 'ModB');
    const firstChildren = await provider.getChildren(node);
    const loadMoreNode = expectInstanceOf(firstChildren.find(c => c instanceof InteriorLoadMoreNode), InteriorLoadMoreNode);

    await provider.loadMore(loadMoreNode);

    expect(repo.calls.filter(c => c.method === 'getInteriorCells').at(-1)).toEqual({
      method: 'getInteriorCells', args: ['Shared.esp', 1, 50, 'ModB'],
    });
  });
});

// ── browsing a specific plugin of a filename (ADR-0012) ────────────────────────

describe('PluginTreeProvider.getPluginChildren (origin)', () => {
  it('asks the repository for the plugin the row stands for', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    await provider.getPluginChildren('Shared.esp', 'ModB');

    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: ['Shared.esp', 'ModB'] });
  });

  it('carries that plugin through to its record pages', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Shared.esp', 'ModB'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(typeNode);

    expect(repo.calls).toContainEqual({ method: 'getRecords', args: ['Shared.esp', 'WEAP', 0, expect.any(Number), 'ModB'] });
  });

  it('caches each plugin separately, so one plugin\'s page is never served for the other', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const fromA = present(expectInstancesOf(await provider.getPluginChildren('Shared.esp', 'ModA'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const fromB = present(expectInstancesOf(await provider.getPluginChildren('Shared.esp', 'ModB'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(fromA);
    await provider.getChildren(fromB);

    // Two fetches, not one served from a shared "Shared.esp::WEAP" cache entry.
    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(2);
  });

  // ADR-0012: a plugin is `(origin, filename)`, and both compare without case, as MO2 and a
  // Windows filesystem compare them.
  it('caches one plugin once, whatever case its filename and origin arrive in', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const asListed = present(expectInstancesOf(await provider.getPluginChildren('Shared.esp', 'ModA'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const recased = present(expectInstancesOf(await provider.getPluginChildren('shared.ESP', 'moda'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    await provider.getChildren(asListed);
    await provider.getChildren(recased);

    expect(repo.calls.filter(c => c.method === 'getRecords')).toHaveLength(1);
  });

  it('omits origin when the row is an ordinary load-order plugin', async () => {
    // The server resolves it from the load order, which is unambiguous there — Mod Management's
    // own rows have no origin to give.
    const repo = makeClient({ recordTypes: [{ type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    await provider.getPluginChildren('Plugin0.esp');

    expect(repo.calls).toContainEqual({ method: 'getRecordTypes', args: ['Plugin0.esp', undefined] });
  });
});

describe('PluginTreeProvider.getPluginChildren (spatial nodes on a specific plugin)', () => {
  // The spatial routes take an explicit origin, so a plugin the load order does not name
  // is not omitted from spatial browsing — it gets its
  // own Worldspaces/Interior-cells nodes, carrying that plugin's origin down the chain.
  it('still builds the spatial group nodes for a plugin the load order does not name, carrying that plugin\'s origin', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'cell', count: 2 }, { type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Shared.esp', 'ModB');

    const worldspaces = children.find(c => c instanceof WorldspacesNode);
    const interiorCells = children.find(c => c instanceof InteriorCellsNode);
    expect(worldspaces?.origin).toBe('ModB');
    expect(interiorCells?.origin).toBe('ModB');
  });

  it('still builds them for an ordinary load-order plugin', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1 }, { type: 'WEAP', count: 1 }] });
    const provider = new PluginTreeProvider(repo);

    const children = await provider.getPluginChildren('Plugin0.esp');

    expect(children.some(c => c instanceof WorldspacesNode)).toBe(true);
  });
});

// ── Quest/DialogTopic child records ────────────────────────────────────────────

function makeContainerChild(
  formKey: string, recordType: string, editorId: string | null = null, hasContainerChildren = false,
): ContainerChildSummary {
  return {
    formKey, editorId, plugin: 'Fallout4.esm', origin: 'Data',
    loadOrderIndex: 0, isWinner: true, workingTreeState: 'None', recordType, hasContainerChildren,
    hasParseFailure: false,
  };
}

describe('RecordNode collapsibility for container types', () => {
  // Rival named: a RecordNode that always constructs CollapsibleState.None regardless of
  // record type — this pins the behaviour against exactly that rival.
  it('is Collapsed when built as a "qust" row that actually has container children', () => {
    const node = new RecordNode(makeRecord(0), undefined, undefined, 'qust', true);
    expect(node.collapsibleState).toBe(1); // TreeItemCollapsibleState.Collapsed (mocked to 1 above)
  });

  it('is Collapsed when built as a "dial" row that actually has container children', () => {
    const node = new RecordNode(makeRecord(0), undefined, undefined, 'dial', true);
    expect(node.collapsibleState).toBe(1);
  });

  // Collapsibility reads the listing's own hasContainerChildren fact, not the record's type
  // signature: a Quest with zero container children must show no expand chevron.
  it('stays None (a leaf) when built as a "qust" row with no container children', () => {
    const node = new RecordNode(makeRecord(0), undefined, undefined, 'qust', false);
    expect(node.collapsibleState).toBe(0);
  });

  it('stays None (a leaf) when built as a "dial" row with no container children', () => {
    const node = new RecordNode(makeRecord(0), undefined, undefined, 'dial', false);
    expect(node.collapsibleState).toBe(0);
  });

  it('stays None (a leaf) when no containerChildType is given, as every other record type does', () => {
    const node = new RecordNode(makeRecord(0));
    expect(node.collapsibleState).toBe(0); // TreeItemCollapsibleState.None
  });
});

describe('PluginTreeProvider.getChildren(RecordNode) — container children', () => {
  it('a "qust" RecordNode expands via repository.getContainerChildren into ordinary RecordNodes', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA'),
      makeContainerChild('dlbr1:Fallout4.esm', 'dlbr', 'BranchA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, undefined, 'qust');

    const children = await provider.getChildren(questNode);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: ['Fallout4.esm', 'qust1:Fallout4.esm', undefined] });
    expect(children).toHaveLength(2);
    expect(children.every(c => c instanceof RecordNode)).toBe(true);
    expect(expectInstanceOf(children[0], RecordNode).record.editorId).toBe('TopicA');
    // Standard record-row affordances — same command every ordinary
    // RecordNode gets, so a container child opens in the record editor exactly like any other row.
    expect(expectInstanceOf(children[0], RecordNode).command).toMatchObject({ command: 'modbench.openEditor' });
  });

  // dial1 has a genuine container child and dial2 has none: a "dial" child with no children must
  // stay a leaf exactly like a top-level one, or every dial row shows a chevron expanding to nothing.
  it('a returned "dial" child with its own children is itself Collapsed — expandable to its own Responses; one with none stays a leaf', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('dial1:Fallout4.esm', 'dial', 'TopicA', true),
      makeContainerChild('dial2:Fallout4.esm', 'dial', 'TopicB', false),
      makeContainerChild('scen1:Fallout4.esm', 'scen', 'SceneA'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, undefined, 'qust', true);

    const children = expectInstancesOf(await provider.getChildren(questNode), RecordNode);

    const dialWithChildren = present(children.find(c => c.record.formKey === 'dial1:Fallout4.esm'), 'the dial1 row');
    const dialWithoutChildren = present(children.find(c => c.record.formKey === 'dial2:Fallout4.esm'), 'the dial2 row');
    const scenChild = present(children.find(c => c.record.formKey === 'scen1:Fallout4.esm'), 'the scen1 row');
    expect(dialWithChildren.collapsibleState).toBe(1); // Collapsed — a nested "dial" with its own children
    expect(dialWithoutChildren.collapsibleState).toBe(0); // None — a "dial" with none stays a leaf
    expect(scenChild.collapsibleState).toBe(0); // None — a Scene is always a leaf
  });

  it('a "dial" RecordNode expands via repository.getContainerChildren into its Responses', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [
      makeContainerChild('info1:Fallout4.esm', 'info'),
    ]);
    const provider = new PluginTreeProvider(repo);
    const topicNode = new RecordNode(
      { ...makeRecord(0), formKey: 'dial1:Fallout4.esm' }, undefined, undefined, 'dial');

    const children = await provider.getChildren(topicNode);

    expect(repo.calls).toContainEqual({ method: 'getContainerChildren', args: ['Fallout4.esm', 'dial1:Fallout4.esm', undefined] });
    expect(children).toHaveLength(1);
  });

  it('caches on second expand without re-fetching', async () => {
    const repo = makeClient();
    repo.setQueryAnswer('getContainerChildren', [makeContainerChild('dial1:Fallout4.esm', 'dial')]);
    const provider = new PluginTreeProvider(repo);
    const questNode = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Fallout4.esm' }, undefined, undefined, 'qust');

    await provider.getChildren(questNode);
    await provider.getChildren(questNode);

    expect(repo.calls.filter(c => c.method === 'getContainerChildren')).toHaveLength(1);
  });

  // Two same-filename plugins expanding the same Quest FormKey must hit their own cache entry: a
  // key built from formKey alone returns ModA's cached children for ModB's expansion.
  it('origin-keyed caching: two plugins that share a filename browse their own children independently', async () => {
    const repo = makeClient();
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-a:Shared.esp', 'dial', 'TopicModA')]);
    repo.setQueryAnswerOnce('getContainerChildren', [makeContainerChild('dial-b:Shared.esp', 'dial', 'TopicModB')]);
    const provider = new PluginTreeProvider(repo);
    const questA = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModA', undefined, 'qust');
    const questB = new RecordNode(
      { ...makeRecord(0), formKey: 'qust1:Shared.esp', plugin: 'Shared.esp' }, 'ModB', undefined, 'qust');

    const childrenA = expectInstancesOf(await provider.getChildren(questA), RecordNode);
    const childrenB = expectInstancesOf(await provider.getChildren(questB), RecordNode);

    const containerCalls = repo.calls.filter(c => c.method === 'getContainerChildren');
    expect(containerCalls).toHaveLength(2);
    expect(present(containerCalls[0], 'the first getContainerChildren call').args).toEqual(['Shared.esp', 'qust1:Shared.esp', 'ModA']);
    expect(present(containerCalls[1], 'the second getContainerChildren call').args).toEqual(['Shared.esp', 'qust1:Shared.esp', 'ModB']);
    expect(present(childrenA[0], "ModA's sole child").record.editorId).toBe('TopicModA');
    expect(present(childrenB[0], "ModB's sole child").record.editorId).toBe('TopicModB');
  });
});

// ── the failure prefix ────────────────────────────────────────────────────────

describe('the failure prefix', () => {
  it('marks a record whose document could not be read, and only that record', async () => {
    const unreadable = { ...makeRecord(0), parseDiagnosis: 'Perk 0000EF — unknown: bad flag', hasParseFailure: true };
    const repo = makeClient({ records: { items: [unreadable, makeRecord(1)], total: 2 } });
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');

    const recordRows = expectInstancesOf(await provider.getChildren(typeNode), RecordNode);
    const failed = present(recordRows[0], 'the unreadable record row');
    const healthy = present(recordRows[1], 'the readable record row');

    expect(expectInstanceOf(failed.iconPath, ThemeIcon).id).toBe('error');
    expect(failed.tooltip).toContain('Perk 0000EF — unknown: bad flag');
    expect(healthy.iconPath).toBeUndefined();
  });

  it('marks the record-type node holding an unreadable record, and only that node', async () => {
    const repo = makeClient({
      recordTypes: [
        { type: 'perk', count: 2, displayName: 'Perk', hasParseFailure: true },
        { type: 'WEAP', count: 5, displayName: 'Weapon', hasParseFailure: false },
      ],
    });
    const provider = new PluginTreeProvider(repo);

    const typeNodes = expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode);
    const perk = present(typeNodes[0], 'the perk type node');
    const weap = present(typeNodes[1], 'the WEAP type node');

    expect(expectInstanceOf(perk.iconPath, ThemeIcon).id).toBe('error');
    expect(perk.description).toBe('2');
    expect(weap.iconPath).toBeUndefined();
  });

  it('marks the whole worldspace chain a failure sits under, and nothing beside it', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'wrld', count: 1, hasParseFailure: true }] });
    repo.setQueryAnswer('getWorldspaces', [
      { formKey: 'wrld:M.esp', editorId: 'World', hasParseFailure: true },
      { formKey: 'other:M.esp', editorId: 'Other', hasParseFailure: false },
    ]);
    repo.setQueryAnswer('getWorldspaceBlocks', {
      topCells: [],
      blocks: [{ x: 0, y: 0, hasParseFailure: true, subBlocks: [{ x: 0, y: 0, hasParseFailure: true,
        cells: [{ formKey: 'c:M.esp', editorId: null, cellX: 1, cellY: 1, isPersistentWorldspaceCell: false, hasParseFailure: true }] }] }],
    });
    repo.setQueryAnswer('getCellReferences', {
      persistent: [{ formKey: 'p:M.esp', editorId: 'Ref', baseFormKey: null, recordType: 'refr', hasParseFailure: true }],
      temporary: [],
    });
    const provider = new PluginTreeProvider(repo);

    const [wsRoot] = await provider.getPluginChildren('Plugin0.esp');
    const [failing, healthy] = await provider.getChildren(wsRoot);
    const [blockNode] = await provider.getChildren(failing);
    const [subBlock] = await provider.getChildren(blockNode);
    const [cellNode] = await provider.getChildren(subBlock);
    const [persistentGroup] = await provider.getChildren(cellNode);
    const [placedNode] = await provider.getChildren(persistentGroup);

    for (const node of [
      present(wsRoot, 'the worldspace root'),
      present(failing, 'the failing top cell'),
      present(blockNode, 'the block node'),
      present(subBlock, 'the sub-block node'),
      present(cellNode, 'the cell node'),
      present(persistentGroup, 'the persistent group'),
      present(placedNode, 'the placed node'),
    ]) {
      expect(expectInstanceOfOrUndefined(node.iconPath, ThemeIcon)?.id).toBe('error');
    }
    expect(present(healthy, 'the healthy top-level child').iconPath).toBeUndefined();
  });

  it('marks an interior cell that cannot be read, and its group node', async () => {
    const repo = makeClient({ recordTypes: [{ type: 'cell', count: 2, hasParseFailure: true }] });
    repo.setQueryAnswer('getInteriorCells', {
      items: [
        { formKey: 'bad:M.esp', editorId: 'Bad', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasParseFailure: true },
        { formKey: 'ok:M.esp', editorId: 'Ok', cellX: null, cellY: null, isPersistentWorldspaceCell: false, hasParseFailure: false },
      ],
      total: 2,
    });
    const provider = new PluginTreeProvider(repo);

    const [interiorRootOrUndefined] = await provider.getPluginChildren('Plugin0.esp');
    const interiorRoot = present(interiorRootOrUndefined, 'the interior-cells root');
    const [bad, ok] = await provider.getChildren(interiorRoot);

    expect(expectInstanceOf(interiorRoot.iconPath, ThemeIcon).id).toBe('error');
    expect(expectInstanceOf(present(bad, 'the unreadable interior cell').iconPath, ThemeIcon).id).toBe('error');
    expect(present(ok, 'the readable interior cell').iconPath).toBeUndefined();
  });

  it('marks a container child that cannot be read, and the container row above it', async () => {
    const repo = makeClient({
      recordTypes: [{ type: 'qust', count: 1 }],
      records: { items: [{ ...makeRecord(0, 'None', true), hasParseFailure: true }], total: 1 },
    });
    repo.setQueryAnswer('getContainerChildren', [
      { ...makeRecord(1), recordType: 'info', hasContainerChildren: false,
        parseDiagnosis: 'INFO 12 — unknown: bad', hasParseFailure: true },
    ]);
    const provider = new PluginTreeProvider(repo);
    const typeNode = present(expectInstancesOf(await provider.getPluginChildren('Plugin0.esp'), RecordTypeNode)[0], 'the sole RecordTypeNode');
    const [questRowOrUndefined] = await provider.getChildren(typeNode);
    const questRow = present(questRowOrUndefined, 'the qust row');

    const [childRowOrUndefined] = await provider.getChildren(questRow);
    const childRow = present(childRowOrUndefined, 'the unreadable container child');

    expect(expectInstanceOf(questRow.iconPath, ThemeIcon).id).toBe('error');
    expect(expectInstanceOf(childRow.iconPath, ThemeIcon).id).toBe('error');
    expect(childRow.tooltip).toContain('INFO 12');
  });
});

