import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon }));

import {
  ReferencedByTreeProvider,
  ReferencedByReferrerNode,
  ReferencedByHolderNode,
  allHolders,
  ErrorNode,
  referencedByCopyText,
  referencedByCopyValueText,
  REFERENCED_BY_VIEW,
} from '../ReferencedByTreeProvider';
import { InMemoryMEditClient } from '../../client';
import { recordArgument } from '../recordLifecycleCommands';
import { expectInstancesOf } from '../../test/expectInstanceOf';
import type { NotificationEvent, ReferenceResult } from '../../client';
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
function rowsChanged(): NotificationEvent {
  return { kind: 'rows-changed', plugin: '', origin: '', keys: [], sequence: 0 };
}

function pluginChanged(): NotificationEvent {
  return { kind: 'plugin-changed', plugin: '', origin: '', keys: [], sequence: 0 };
}

function loadOrderStatus(conflictsComputed: boolean): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed, failures: [], version: 1,
    },
  };
}

function makeClient(references?: ReferenceResult[]): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  if (references !== undefined) client.setQueryAnswer('getReferences', references);
  return client;
}

describe('ReferencedByTreeProvider — no active record', () => {
  it('has no rows and asks nothing of the client before any showFor, and says to open a record', async () => {
    const client = makeClient();
    const provider = new ReferencedByTreeProvider(client);
    expect(await provider.getChildren()).toEqual([]);
    expect(provider.viewMessage()).toBe('Open a record to see what references it.');
    expect(provider.count()).toBeUndefined();
    expect(client.calls.filter((c) => c.method !== 'subscribe')).toEqual([]);
  });

  it('empties when retargeted to undefined (the last record tab closed), and says to open a record', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    provider.showFor(undefined);
    expect(await provider.getChildren()).toEqual([]);
    expect(provider.viewMessage()).toBe('Open a record to see what references it.');
    expect(provider.count()).toBeUndefined();
    expect(provider.recordName()).toBeUndefined();
    expect(client.calls.filter((c) => c.method === 'getReferences')).toHaveLength(1);
  });
});

describe('ReferencedByTreeProvider — root, after showFor', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows one error row naming the reason, with no count, when the first read fails, and logs it once', async () => {
    const log = vi.fn();
    const client = makeClient();
    client.setQueryFailure('getReferences', new Error('boom'));
    const provider = new ReferencedByTreeProvider(client, log);
    provider.showFor('000001:Fallout4.esm');
    const [error, ...rest] = expectInstancesOf(await provider.getChildren(), ErrorNode);
    expect(rest).toEqual([]);
    expect(error?.label).toBe('Failed to load: boom');
    expect(error?.tooltip).toBe('boom');
    expect(provider.count()).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows and says it is the last good read when a later read fails', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client, vi.fn());
    client.emit(loadOrderStatus(true));
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    client.setQueryFailure('getReferences', new Error('boom'));
    client.emit(rowsChanged());
    expect(expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode)).toHaveLength(1);
    expect(provider.viewMessage()).toBe('Showing the last good read: boom');
    expect(provider.count()).toBe(1);
  });

  it('has no rows and no message while the first read has not landed', () => {
    const client = makeClient([]);
    client.setQueryAnswerOnce('getReferences', new Promise(() => undefined));
    const provider = new ReferencedByTreeProvider(client);
    client.emit(loadOrderStatus(true));
    provider.showFor('000001:Fallout4.esm');
    void provider.getChildren();
    expect(provider.viewMessage()).toBeUndefined();
    expect(provider.count()).toBeUndefined();
  });

  it('has no rows and says none was found when nothing references the record', async () => {
    const client = makeClient([]);
    const provider = new ReferencedByTreeProvider(client);
    client.emit(loadOrderStatus(true));
    provider.showFor('000001:Fallout4.esm');
    expect(await provider.getChildren()).toEqual([]);
    expect(provider.viewMessage()).toBe('No references found.');
    expect(provider.count()).toBe(0);
  });

  it('says the list may be incomplete until mEdit has indexed the plugins', async () => {
    const client = makeClient([reference({ formKey: '000002:Fallout4.esm' })]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(provider.viewMessage()).toBe('mEdit is still indexing plugins: this list may not be complete.');
    client.emit(loadOrderStatus(true));
    expect(provider.viewMessage()).toBeUndefined();
  });

  it('reads again when the index settles, and when records or plugins change on disk', async () => {
    const client = makeClient([]);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    const reads = () => client.calls.filter((c) => c.method === 'getReferences').length;
    for (const event of [loadOrderStatus(true), rowsChanged(), pluginChanged()]) {
      const before = reads();
      client.emit(event);
      await provider.getChildren();
      expect(reads()).toBe(before + 1);
    }
  });

  it('names the record the list is about by its title, the FormKey when mEdit gives no EditorID', async () => {
    const client = makeClient([]);
    client.setQueryAnswer('getComparison', null);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    await provider.getChildren();
    expect(provider.recordName()).toBe('000001:Fallout4.esm');
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

describe('ReferencedByTreeProvider — order and filter', () => {
  const referrers = [
    reference({ formKey: '000004:Fallout4.esm', editorId: 'Zed', recordTypeName: 'Armor' }),
    reference({ formKey: '000002:Fallout4.esm', editorId: 'Beta', recordTypeName: 'Weapon' }),
    reference({ formKey: '000003:Fallout4.esm', editorId: 'Alpha', recordTypeName: 'Weapon' }),
    reference({ formKey: '000005:Fallout4.esm', recordTypeName: 'Armor' }),
  ];
  const labels = async (provider: ReferencedByTreeProvider) =>
    expectInstancesOf(await provider.getChildren(), ReferencedByReferrerNode).map((r) => r.label);

  it('sorts referrers by record type, then by label, and reverses on the toggle', async () => {
    const provider = new ReferencedByTreeProvider(makeClient(referrers));
    provider.showFor('000001:Fallout4.esm');
    expect(await labels(provider)).toEqual(['000005:Fallout4.esm', 'Zed', 'Alpha', 'Beta']);
    provider.setDirection('descending');
    expect(await labels(provider)).toEqual(['Beta', 'Alpha', 'Zed', '000005:Fallout4.esm']);
  });

  it('narrows by case-insensitive substring of the label, leaving the count at every referrer', async () => {
    const provider = new ReferencedByTreeProvider(makeClient(referrers));
    provider.showFor('000001:Fallout4.esm');
    provider.setFilter('ALP');
    expect(await labels(provider)).toEqual(['Alpha']);
    expect(provider.count()).toBe(4);
    provider.setFilter('');
    expect(await labels(provider)).toHaveLength(4);
  });

  it('keeps the filter across a new record and a read on disk change', async () => {
    const client = makeClient(referrers);
    const provider = new ReferencedByTreeProvider(client);
    provider.showFor('000001:Fallout4.esm');
    provider.setFilter('alp');
    provider.showFor('000009:Fallout4.esm');
    client.emit(rowsChanged());
    expect(await labels(provider)).toEqual(['Alpha']);
  });

  it('claims no match only when referrers exist and the term hides every one', async () => {
    const provider = new ReferencedByTreeProvider(makeClient(referrers));
    provider.showFor('000001:Fallout4.esm');
    provider.setFilter('nothing');
    expect(await provider.hasRows()).toBe(false);
    provider.setFilter('alp');
    expect(await provider.hasRows()).toBe(true);
    const none = new ReferencedByTreeProvider(makeClient([]));
    none.showFor('000001:Fallout4.esm');
    none.setFilter('nothing');
    expect(await none.hasRows()).toBe(true);
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
    expect(referencedByCopyText([secondReferrer, firstReferrer])).toBe('TestNPC [000002:Fallout4.esm]\nOtherNPC [000003:Fallout4.esm]');
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
