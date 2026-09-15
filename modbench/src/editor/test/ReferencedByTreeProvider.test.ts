import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon }));

import {
  ReferencedByTreeProvider,
  ReferencedByGroupNode,
  ReferencedByFieldNode,
  EmptyStateNode,
  ErrorNode,
  NoActiveRecordNode,
  referencedByCopyText,
} from '../ReferencedByTreeProvider';
import { InMemoryMEditClient } from '../../medit/client';
import { expectInstanceOf, expectInstancesOf } from '../../test/expectInstanceOf';
import type { ReferenceResult } from '../../medit/client';
import { present } from '../../present';

function reference(overrides: Partial<ReferenceResult> & { formKey: string }): ReferenceResult {
  return { plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'NPC_', editorId: null, origin: 'Fallout4.esm', ...overrides };
}

// A test that forgets to script `getReferences` gets the in-memory adapter's own loud rejection
// — the same shape a real backend failure produces once caught below — so no separate "ok: false"
// script is needed.
function makeClient(references?: ReferenceResult[]): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  if (references !== undefined) client.setQueryAnswer('getReferences', references);
  return client;
}

describe('ReferencedByTreeProvider — no active record', () => {
  it('returns a NoActiveRecordNode without calling the client, before any showFor', async () => {
    const client = makeClient();
    const provider = new ReferencedByTreeProvider(client);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(NoActiveRecordNode);
    expect(client.calls).toEqual([]);
  });

  it('returns a NoActiveRecordNode when retargeted to undefined (record panel closed)', async () => {
    const client = makeClient([]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    provider.showFor(undefined);
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(NoActiveRecordNode);
    expect(client.calls.filter((c) => c.method === 'getReferences')).toHaveLength(1);
  });
});

describe('ReferencedByTreeProvider — root, after showFor', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns an ErrorNode (not an empty list) when the fetch fails', async () => {
    const provider = new ReferencedByTreeProvider(makeClient(), vi.fn());
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorNode);
  });

  it('returns an EmptyStateNode when there are no references', async () => {
    const provider = new ReferencedByTreeProvider(makeClient([]));
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(EmptyStateNode);
    expect(present(children[0], 'the sole EmptyStateNode row').label).toBe('No references found.');
  });

  it('groups a single reference with no plugin-count suffix', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const group = expectInstanceOf(children[0], ReferencedByGroupNode);
    expect(group).toBeInstanceOf(ReferencedByGroupNode);
    expect(group.label).toBe('NPC_ / TestNPC');
    expect(group.description).toBeUndefined();
  });

  it('groups multiple plugin overrides of the same referencer with a plugin count', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', recordType: 'NPC_', editorId: 'TestNPC' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(1);
    const group = expectInstanceOf(children[0], ReferencedByGroupNode);
    expect(group.description).toBe('2 plugins');
  });

  it('renders two distinct referencers as two top-level groups', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
      reference({ formKey: '000003:Fallout4.esm', recordType: 'NPC_', editorId: 'OtherNPC', fieldPath: 'Template' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const children = await provider.getChildren();
    expect(children).toHaveLength(2);
  });

  it("a group's command opens its record", async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    expect(present(group, 'the single referencer group').command).toEqual({
      command: 'modbench.openEditor',
      title: 'Open Record',
      arguments: [{ formKey: '000002:Fallout4.esm', label: 'TestNPC' }],
    });
  });
});

describe('ReferencedByTreeProvider — group children (field rows)', () => {
  it('expands to one field row per plugin, with no command', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', fieldPath: 'DefaultOutfit' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    const fields = await provider.getChildren(group);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBeInstanceOf(ReferencedByFieldNode);
    const firstField = present(fields[0], 'the first field row');
    const secondField = present(fields[1], 'the second field row');
    expect(firstField.label).toBe('Fallout4.esm · DefaultOutfit');
    expect(firstField.command).toBeUndefined();
    expect(secondField.label).toBe('MyMod.esp · DefaultOutfit');
  });
});

describe('ReferencedByTreeProvider — referrer count (view-title badge)', () => {
  it('reports undefined when there is no active record', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient(), undefined, onCountChanged);
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(undefined);
  });

  it('reports undefined (not 0) when the fetch fails, so a failure never reads as "no references"', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient(), undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(undefined);
  });

  it('reports 0 for a genuine zero-referrer result', async () => {
    const onCountChanged = vi.fn();
    const provider = new ReferencedByTreeProvider(makeClient([]), undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(0);
  });

  it('reports the number of distinct referencing groups, not the raw row count', async () => {
    const onCountChanged = vi.fn();
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp' }),
      reference({ formKey: '000003:Fallout4.esm' }),
    ]);
    const provider = new ReferencedByTreeProvider(client, undefined, onCountChanged);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(onCountChanged).toHaveBeenCalledWith(2);
  });
});

describe('referencedByCopyText — the clipboard copy command\'s text', () => {
  it('returns empty text for an empty selection', () => {
    expect(referencedByCopyText([])).toBe('');
  });

  it("copies a single selected group's own displayed label", async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    expect(referencedByCopyText([present(group, 'the single referencer group')])).toBe('NPC_ / TestNPC');
  });

  it('joins multiple selected groups one per line, in selection order', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC' }),
      reference({ formKey: '000003:Fallout4.esm', recordType: 'NPC_', editorId: 'OtherNPC', fieldPath: 'Template' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [first, second] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    const firstGroup = present(first, 'the first referencer group');
    const secondGroup = present(second, 'the second referencer group');
    expect(referencedByCopyText([secondGroup, firstGroup])).toBe('NPC_ / OtherNPC\nNPC_ / TestNPC');
  });

  it('excludes a selected field row — the group is the copyable unit, field rows are detail', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', recordType: 'NPC_', editorId: 'TestNPC', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    const [field] = expectInstancesOf(await provider.getChildren(group), ReferencedByFieldNode);
    expect(referencedByCopyText([
      present(group, 'the referencer group'), present(field, 'its field row'),
    ])).toBe('NPC_ / TestNPC');
  });

  it('returns empty text when only a field row is selected (no group in the selection)', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [group] = expectInstancesOf(await provider.getChildren(), ReferencedByGroupNode);
    const [field] = expectInstancesOf(await provider.getChildren(group), ReferencedByFieldNode);
    expect(referencedByCopyText([present(field, 'the field row')])).toBe('');
  });
});

describe('ReferencedByTreeProvider — showFor retargeting', () => {
  it('fires onDidChangeTreeData and re-queries the new FormKey', async () => {
    const client = makeClient([]);
    const provider = new ReferencedByTreeProvider(client);
    const handler = vi.fn();
    provider.onDidChangeTreeData(handler);
    provider.showFor('000001:Fallout4.esm');
    expect(handler).toHaveBeenCalledTimes(1);
    await provider.getChildren();
    expect(client.calls).toContainEqual({ method: 'getReferences', args: ['000001:Fallout4.esm'] });
  });
});
