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
  ReferencedByTreeProvider,
  ReferencedByGroupNode,
  ReferencedByFieldNode,
  EmptyStateNode,
  ErrorNode,
  NoActiveRecordNode,
  referencedByCopyText,
} from '../ReferencedByTreeProvider';

type Reference = {
  formKey: string;
  plugin: string;
  fieldPath: string;
  recordType: string;
  editorId: string | null;
};

function reference(overrides: Partial<Reference> & { formKey: string }): Reference {
  return { plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: null, ...overrides };
}

function makeClient(opts: { references?: Reference[]; ok?: boolean; status?: number }) {
  const { references = [], ok = true, status = ok ? 200 : 500 } = opts;
  return {
    GET: vi.fn().mockImplementation(() =>
      Promise.resolve({ data: ok ? references : undefined, response: { ok, status } })),
  } as any;
}

describe('ReferencedByTreeProvider — no active record', () => {
  it('returns a NoActiveRecordNode without calling the client, before any showFor', async () => {
    const client = makeClient({});
    const provider = new ReferencedByTreeProvider(client);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(NoActiveRecordNode);
    expect(client.GET).not.toHaveBeenCalled();
  });

  it('returns a NoActiveRecordNode when retargeted to undefined (record panel closed)', async () => {
    const client = makeClient({ references: [] });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    provider.showFor(undefined);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(NoActiveRecordNode);
    expect(client.GET).toHaveBeenCalledTimes(1);
  });
});

describe('ReferencedByTreeProvider — root, after showFor', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns an ErrorNode (not an empty list) when the fetch fails', async () => {
    const provider = new ReferencedByTreeProvider(makeClient({ ok: false }), vi.fn());
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('returns an EmptyStateNode when there are no references', async () => {
    const provider = new ReferencedByTreeProvider(makeClient({ references: [] }));
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyStateNode);
    expect((children[0]).label).toBe('No references found.');
  });

  it('groups a single reference with no plugin-count suffix', async () => {
    const client = makeClient({
      references: [reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const group = children[0] as ReferencedByGroupNode;
    expect(group).toBeInstanceOf(ReferencedByGroupNode);
    expect(group.label).toBe('NPC_ / TestNPC');
    expect(group.description).toBeUndefined();
  });

  it('groups multiple plugin overrides of the same referencer with a plugin count', async () => {
    const client = makeClient({
      references: [
        reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
        reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', recordType: 'NPC_', editorId: 'TestNPC' }),
      ],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const group = children[0] as ReferencedByGroupNode;
    expect(group.description).toBe('2 plugins');
  });

  it('renders two distinct referencers as two top-level groups', async () => {
    const client = makeClient({
      references: [
        reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
        reference({ formKey: '000003:Fallout4.esm', recordType: 'NPC_', editorId: 'OtherNPC', fieldPath: 'Template' }),
      ],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
  });

  it("a group's command opens its record", async () => {
    const client = makeClient({
      references: [reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = await provider.getChildren() as ReferencedByGroupNode[];
    expect(group.command).toEqual({
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: '000002:Fallout4.esm', label: 'TestNPC' }],
    });
  });
});

describe('ReferencedByTreeProvider — group children (field rows)', () => {
  it('expands to one field row per plugin, with no command', async () => {
    const client = makeClient({
      references: [
        reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' }),
        reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'DefaultOutfit' }),
      ],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = await provider.getChildren() as ReferencedByGroupNode[];
    const fields = await provider.getChildren(group);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBeInstanceOf(ReferencedByFieldNode);
    expect(fields[0].label).toBe('Fallout4.esm · DefaultOutfit');
    expect(fields[0].command).toBeUndefined();
    expect(fields[1].label).toBe('MyMod.esp · DefaultOutfit');
  });
});

describe('ReferencedByTreeProvider — referrer count (#282, view-title badge)', () => {
  it('reports undefined when there is no active record', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient({}), undefined, onCountChanged);
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(undefined);
  });

  it('reports undefined (not 0) when the fetch fails, so a failure never reads as "no references"', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient({ ok: false }), undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(undefined);
  });

  it('reports 0 for a genuine zero-referrer result', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient({ references: [] }), undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(0);
  });

  it('reports the number of distinct referencing groups, not the raw row count', async () => {
    const onCountChanged = vi.fn();
    const client = makeClient({
      references: [
        reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm' }),
        reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp' }),
        reference({ formKey: '000003:Fallout4.esm' }),
      ],
    });
    const provider = new ReferencedByTreeProvider(client, undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(2);
  });
});

describe('referencedByCopyText — the clipboard copy command\'s text (#282)', () => {
  it('returns empty text for an empty selection', () => {
    expect(referencedByCopyText([])).toBe('');
  });

  it("copies a single selected group's own displayed label", async () => {
    const client = makeClient({
      references: [reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = await provider.getChildren() as ReferencedByGroupNode[];
    expect(referencedByCopyText([group])).toBe('NPC_ / TestNPC');
  });

  it('joins multiple selected groups one per line, in selection order', async () => {
    const client = makeClient({
      references: [
        reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
        reference({ formKey: '000003:Fallout4.esm', recordType: 'NPC_', editorId: 'OtherNPC', fieldPath: 'Template' }),
      ],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [first, second] = await provider.getChildren() as ReferencedByGroupNode[];
    expect(referencedByCopyText([second, first])).toBe('NPC_ / OtherNPC\nNPC_ / TestNPC');
  });

  it('excludes a selected field row — the group is the copyable unit, field rows are detail', async () => {
    const client = makeClient({
      references: [reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' })],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = await provider.getChildren() as ReferencedByGroupNode[];
    const [field] = await provider.getChildren(group) as ReferencedByFieldNode[];
    expect(referencedByCopyText([group, field])).toBe('NPC_ / TestNPC');
  });

  it('returns empty text when only a field row is selected (no group in the selection)', async () => {
    const client = makeClient({
      references: [reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' })],
    });
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = await provider.getChildren() as ReferencedByGroupNode[];
    const [field] = await provider.getChildren(group) as ReferencedByFieldNode[];
    expect(referencedByCopyText([field])).toBe('');
  });
});

describe('ReferencedByTreeProvider — showFor retargeting', () => {
  it('fires onDidChangeTreeData and re-queries the new FormKey', async () => {
    const client = makeClient({ references: [] });
    const provider = new ReferencedByTreeProvider(client);
    const handler = vi.fn();
    provider.onDidChangeTreeData(handler);
    provider.showFor('000001:Fallout4.esm');
    expect(handler).toHaveBeenCalledTimes(1);
    await provider.getChildren();
    expect(client.GET).toHaveBeenCalledWith(
      '/records/{formKey}/references',
      { params: { path: { formKey: '000001:Fallout4.esm' } } },
    );
  });
});
