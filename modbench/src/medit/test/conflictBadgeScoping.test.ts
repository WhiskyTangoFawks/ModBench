import { describe, it, expect, vi } from 'vitest';
import type { RecordSummary, ConflictingRecord } from '../ApiClient';
import type { PluginRepository } from '../PluginRepository';

// The record conflict badge must render only on the Conflicts node's own
// rows, never on an ordinary RecordTypeNode -> RecordNode row for the same record elsewhere in
// the tree — a bare
// identity-keyed FileDecorationProvider lookup would badge every URI sharing that identity. This is
// the direct cross-module proof: PluginTreeProvider builds both flavors of RecordNode for the
// identical (plugin, origin, formKey), and RecordDecorationProvider — wired the same way
// extension.ts wires it in production — badges one and not the other.
vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    contextValue?: string;
    iconPath?: unknown;
    collapsibleState: number;
    command?: unknown;
    resourceUri?: unknown;
    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    private handlers: ((e: unknown) => void)[] = [];
    get event() { return (h: (e: unknown) => void) => { this.handlers.push(h); }; }
    fire(e?: unknown) { this.handlers.forEach((h) => h(e)); }
  },
  ThemeIcon: class { constructor(public id: string) {} },
  ThemeColor: class { constructor(public id: string) {} },
  Uri: {
    from: (opts: { scheme: string; path: string; query?: string }) =>
      ({ scheme: opts.scheme, path: opts.path, query: opts.query ?? '' }),
  },
}));

import { PluginTreeProvider, RecordTypeNode, RecordNode } from '../PluginTreeProvider';
import { RecordDecorationProvider } from '../RecordDecorationProvider';

const RECORD: RecordSummary = {
  formKey: 'Fallout4.esm:000801',
  plugin: 'Fallout4.esm',
  loadOrderIndex: 0,
  isWinner: true,
  editorId: 'SharedRecord',
  workingTreeState: 'None',
};

function makeRepository(): PluginRepository {
  const conflicts: ConflictingRecord[] = [{ record: RECORD, origin: 'Data', conflictAll: 'Conflict' }];
  return {
    getConflicts: vi.fn().mockResolvedValue(conflicts),
    getRecords: vi.fn().mockResolvedValue({ items: [RECORD], total: 1 }),
  } as unknown as PluginRepository;
}

describe('Conflict badge scoping — cross-tree (#364 review)', () => {
  it('badges the record via the Conflicts node, but not via an ordinary RecordTypeNode browse of the same record', async () => {
    const repo = makeRepository();
    const treeProvider = new PluginTreeProvider(repo);
    treeProvider.setConflictsComputed(true);

    // Same wiring shape as extension.ts's makeRecordDecorationProvider.
    const decorationProvider = new RecordDecorationProvider(
      (plugin, origin, formKey) => treeProvider.workingTreeStateOf(plugin, origin, formKey),
      (plugin, origin, formKey) => treeProvider.conflictAllOf(plugin, origin, formKey),
    );

    // 1) Expand the Conflicts node — this is what populates conflictAllCache.
    const conflictsChildren = await treeProvider.getChildren(treeProvider.conflictsNode());
    const conflictsRow = conflictsChildren[0] as RecordNode;
    expect(conflictsRow).toBeInstanceOf(RecordNode);
    expect(conflictsRow.record.formKey).toBe(RECORD.formKey);

    // 2) Browse to the *same* record through an ordinary RecordTypeNode -> RecordNode path — same
    // origin ('Data') as the Conflicts-node entry above, so the only variable between the two rows
    // is the fromConflictsNode marker itself, isolating exactly what the fix depends on.
    const typeNode = new RecordTypeNode('Fallout4.esm', 'npc_', 1, 'npc_', 'Data');
    const ordinaryChildren = await treeProvider.getChildren(typeNode);
    const ordinaryRow = ordinaryChildren[0] as RecordNode;
    expect(ordinaryRow).toBeInstanceOf(RecordNode);
    expect(ordinaryRow.record.formKey).toBe(RECORD.formKey);

    // The two rows share the same record identity but must not share a badge.
    expect(decorationProvider.provideFileDecoration(conflictsRow.resourceUri!)).toEqual({
      badge: 'C',
      color: expect.objectContaining({ id: 'gitDecoration.conflictingResourceForeground' }),
      tooltip: 'Conflict',
    });
    expect(decorationProvider.provideFileDecoration(ordinaryRow.resourceUri!)).toBeUndefined();
  });
});
