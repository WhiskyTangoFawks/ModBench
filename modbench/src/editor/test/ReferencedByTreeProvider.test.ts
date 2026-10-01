import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon }));

import {
  ReferencedByTreeProvider,
  ReferencedByReferrerNode,
  ReferencedByHolderNode,
  allHolders,
  EmptyStateNode,
  ErrorNode,
  NoActiveRecordNode,
  referencedByCopyText,
  referencedByCopyValueText,
  REFERENCED_BY_VIEW,
} from '../ReferencedByTreeProvider';
import { InMemoryMEditClient } from '../../client';
import { recordArgument } from '../recordLifecycleCommands';
import { expectInstancesOf } from '../../test/expectInstanceOf';
import type { ReferenceResult } from '../../client';
import { present } from '../../ports/present';

function reference(overrides: Partial<ReferenceResult> & { formKey: string }): ReferenceResult {
  return {
    plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'npc_', recordTypeName: 'Non-Player Character',
    editorId: null, origin: 'Fallout4.esm', ...overrides,
  };
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

  it('lists a referrer by its EditorID, with the record type as xEdit names it', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(referrer?.label).toBe('TestNPC');
    expect(referrer?.description).toBe('Non-Player Character');
    expect(referrer?.iconPath).toBeUndefined();
    expect(referrer?.tooltip).toBe('TestNPC [000002:Fallout4.esm]\nNon-Player Character\nFallout4.esm');
  });

  it('labels a referrer with no EditorID by its FormKey', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(referrer?.label).toBe('000002:Fallout4.esm');
    expect(referrer?.copyText).toBe('000002:Fallout4.esm');
  });

  it('lists a referrer held in several plugins once, saying how many hold it', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', editorId: 'TestNPC' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', editorId: 'TestNPC' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const referrers = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(referrers).toHaveLength(1);
    expect(referrers[0]?.description).toBe('Non-Player Character · 2 plugins');
  });

  it('counts the plugins that hold a referrer, not the fields that hold the reference', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', fieldPath: 'Keywords[0]' }),
      reference({ formKey: '000002:Fallout4.esm', fieldPath: 'Keywords[1]' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(referrer?.description).toBe('Non-Player Character');
  });

  it('renders two distinct referrers as two rows', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' }),
      reference({ formKey: '000003:Fallout4.esm', editorId: 'OtherNPC', fieldPath: 'Template' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    expect(await provider.getChildren()).toHaveLength(2);
  });

  it("a referrer's click opens its record", async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(present(referrer, 'the referrer').command).toEqual({
      command: 'modbench.record.open',
      title: 'Open Record',
      arguments: [{ formKey: '000002:Fallout4.esm' }],
    });
  });

  it('lists every referrer collapsed each time the list follows a record, a record it followed before included', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' }), reference({ formKey: '000003:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    const states: number[][] = [];
    for (const target of ['000001:Fallout4.esm', '000009:Fallout4.esm', '000001:Fallout4.esm']) {
      provider.showFor(target);
      states.push((await provider.getChildren()).map(r => r.collapsibleState ?? -1));
    }
    expect(states).toEqual([[1, 1], [1, 1], [1, 1]]);
  });

  it('gives a referrer a different identity under each record the list follows, so it collapses again', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [first] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    provider.showFor('000009:Fallout4.esm');
    const [second] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(first?.id).not.toBe(second?.id);
  });
});

describe('ReferencedByTreeProvider — a referrer\'s children (where it is held)', () => {
  it('lists one row per plugin copy, in the order mEdit answers, each naming its fields', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'Keywords[0]' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'Keywords[1]' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', fieldPath: 'Template' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const holders = expectInstancesOf(await provider.getChildren(present(referrer, 'the referrer')), ReferencedByHolderNode);
    expect(holders.map(h => [h.label, h.description])).toEqual([
      ['Fallout4.esm', 'Keywords[0], Keywords[1]'],
      ['MyMod.esp', 'Template'],
    ]);
    expect(holders[0]?.command).toBeUndefined();
  });

  it('keeps two plugins of one file name apart by their origins', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Patch.esp', origin: 'ModA' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Patch.esp', origin: 'ModB' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const holders = expectInstancesOf(await provider.getChildren(present(referrer, 'the referrer')), ReferencedByHolderNode);
    expect(holders.map(h => h.origin)).toEqual(['ModA', 'ModB']);
    expect(new Set(holders.map(h => h.id)).size).toBe(2);
  });

  it('hands copy and delete the plugin copy it stands for, with its origin', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', editorId: 'TestNPC' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const [holder] = expectInstancesOf(await provider.getChildren(present(referrer, 'the referrer')), ReferencedByHolderNode);
    expect(recordArgument(holder)).toEqual({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', editorId: 'TestNPC' });
  });
});

describe('allHolders — the selection copy and delete act on', () => {
  it('holds only for a selection of plugin copies', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const holders = await provider.getChildren(present(referrer, 'the referrer'));
    expect(allHolders(holders)).toBe(true);
    expect(allHolders([...holders, present(referrer, 'the referrer')])).toBe(false);
    expect(allHolders([])).toBe(false);
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

  it('reports the number of distinct referrers, not the raw row count', async () => {
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

  it("copies a single selected referrer as EditorID [FormKey]", async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    expect(referencedByCopyText([present(referrer, 'the single referrer')])).toBe('TestNPC [000002:Fallout4.esm]');
  });

  it('joins multiple selected referrers one per line, in selection order', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' }),
      reference({ formKey: '000003:Fallout4.esm', editorId: 'OtherNPC', fieldPath: 'Template' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [first, second] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const firstReferrer = present(first, 'the first referrer');
    const secondReferrer = present(second, 'the second referrer');
    expect(referencedByCopyText([secondReferrer, firstReferrer])).toBe('OtherNPC [000003:Fallout4.esm]\nTestNPC [000002:Fallout4.esm]');
  });

  it('adds nothing for a selected row beneath a referrer', async () => {
    const client = makeClient([
      reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' }),
    ]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const [copy] = expectInstancesOf(await provider.getChildren(referrer), ReferencedByHolderNode);
    expect(referencedByCopyText([
      present(referrer, 'the referrer'), present(copy, 'its plugin copy'),
    ])).toBe('TestNPC [000002:Fallout4.esm]');
  });

  it('returns empty text when only a row beneath a referrer is selected', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    const [referrer] = expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode);
    const [copy] = expectInstancesOf(await provider.getChildren(referrer), ReferencedByHolderNode);
    expect(referencedByCopyText([present(copy, 'the plugin copy')])).toBe('');
  });
});

describe('referencedByCopyValueText — Referenced By\'s own text for the shared copy value id', () => {
  const referrer = (formKey = '000001:Fallout4.esm') => new ReferencedByReferrerNode('000009:Fallout4.esm', formKey, 'Named', 'Weapon', []);

  it('prefers the selection VS Code hands a context menu over the view\'s own selection', () => {
    const clicked = referrer();
    const stale = referrer('000002:Fallout4.esm');
    expect(referencedByCopyValueText({ selection: [stale] }, clicked, [clicked])).toBe(clicked.copyText);
  });

  it('copies the view\'s own current selection for its Ctrl+C, which names the view', () => {
    const row = referrer();
    expect(referencedByCopyValueText({ selection: [row] }, { view: REFERENCED_BY_VIEW }, undefined)).toBe(row.copyText);
  });

  it('falls back to the clicked row alone with nothing else selected', () => {
    const row = referrer();
    expect(referencedByCopyValueText({ selection: [] }, row, undefined)).toBe(row.copyText);
  });

  it('is empty text for its own Ctrl+C with nothing selected', () => {
    expect(referencedByCopyValueText({ selection: [] }, { view: REFERENCED_BY_VIEW }, undefined)).toBe('');
  });

  it('defers on an invocation of another surface, so an adapter after it can run', () => {
    const selected = { selection: [referrer()] };
    expect(referencedByCopyValueText(selected, undefined, undefined)).toBeUndefined();
    expect(referencedByCopyValueText(selected, { kind: 'mod' }, undefined)).toBeUndefined();
    expect(referencedByCopyValueText(selected, { view: 'modbench.modList' }, undefined)).toBeUndefined();
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
