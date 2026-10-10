import type { NotificationEvent } from '../../client/test/InMemoryMEditClient';
import { leveledLog } from '../../test/leveledLog';
import { describe, it, expect, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ TreeItem, TreeItemCollapsibleState, EventEmitter, ThemeIcon }));

import {
  readReferencedBy,
  referencedByCopyValueText,
  type ConditionsOf,
} from '../referencedByList';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { ReferenceResult } from '../../client';
import { present } from '../../ports/present';
import { recordOpenPlan } from '../recordOpenPlan';

type Node = ReturnType<Awaited<ReturnType<typeof readReferencedBy>>['provider']['getChildren']>[number];
const isHolder = (node: Node): node is Extract<Node, { plugin: unknown }> => 'plugin' in node;

const TARGET = '000001:Fallout4.esm';

function reference(overrides: Partial<ReferenceResult> & { formKey: string }): ReferenceResult {
  return {
    plugin: 'Fallout4.esm', fieldPath: 'DefaultOutfit', recordType: 'npc_', recordTypeName: 'Non-Player Character',
    editorId: null, origin: 'Fallout4.esm', ...overrides,
  };
}

function loadOrderStatus(conflictsComputed: boolean): NotificationEvent {
  return {
    kind: 'load-order-status', plugin: '', origin: '', keys: [], sequence: 0,
    loadOrderStatus: {
      state: 'Ready', totalPlugins: 0, activePlugins: 0, indexedPlugins: [], conflictsComputed, failures: [], version: 1,
    },
  };
}

function indexed(references: ReferenceResult[]): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getReferences', references);
  client.emit(loadOrderStatus(true));
  return client;
}

const NOTHING_EDITABLE: ConditionsOf = () => ({ tracked: false, editable: false });

async function listOf(client: InMemoryMEditClient, list = 'a list', conditionsOf: ConditionsOf = NOTHING_EDITABLE) {
  const read = await readReferencedBy(client, leveledLog(), TARGET, list, conditionsOf);
  return { ...read, referrers: read.provider.getChildren() };
}

const referrersOver = async (references: ReferenceResult[]) => (await listOf(indexed(references))).referrers;

describe('the Referenced By list — states', () => {
  it('says none was found, and has no rows, when nothing references the record', async () => {
    const { referrers, message } = await listOf(indexed([]));
    expect(referrers).toEqual([]);
    expect(message).toBe('No references found.');
  });

  it('has no message once mEdit has indexed the plugins and a referrer is found', async () => {
    expect((await listOf(indexed([reference({ formKey: '000002:Fallout4.esm' })]))).message).toBeUndefined();
  });

  it('says the list may be incomplete while mEdit is still indexing plugins, beside none found', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('getReferences', []);
    expect((await listOf(client)).message).toBe('No references found. mEdit is still indexing plugins: this list may not be complete.');
    client.setQueryAnswer('getReferences', [reference({ formKey: '000002:Fallout4.esm' })]);
    expect((await listOf(client)).message).toBe('mEdit is still indexing plugins: this list may not be complete.');
  });

  it('shows one error row naming the reason when the read fails, and logs it once', async () => {
    const log = leveledLog();
    const client = indexed([]);
    client.setQueryFailure('getReferences', { failed: 'refused', refusal: 'boom' });
    const [error, ...rest] = (await readReferencedBy(client, log, TARGET, 'a list', NOTHING_EDITABLE)).provider.getChildren();
    expect(rest).toEqual([]);
    expect(error?.label).toBe('Failed to load: boom');
    expect(error?.tooltip).toBe('boom');
    expect(log.lines.error).toHaveLength(1);
  });

  it('is a snapshot: mEdit is asked once, however often the view asks for rows and whatever changes after', async () => {
    const client = indexed([reference({ formKey: '000002:Fallout4.esm' })]);
    const { provider } = await readReferencedBy(client, leveledLog(), TARGET, 'a list', NOTHING_EDITABLE);
    client.emit({ kind: 'rows-changed', plugin: '', origin: '', keys: [], sequence: 0 });
    provider.getChildren();
    provider.getChildren();
    expect(client.calls.filter((c) => c.method === 'getReferences')).toEqual([{ method: 'getReferences', args: [TARGET] }]);
  });
});

describe('the Referenced By list — a referrer', () => {
  it('is labelled by its EditorID, with the record type as xEdit names it, and no icon', async () => {
    const [referrer] = await referrersOver([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })]);
    expect(referrer?.label).toBe('TestNPC');
    expect(referrer?.description).toBe('Non-Player Character');
    expect(referrer?.iconPath).toBeUndefined();
    expect(referrer?.tooltip).toBe('TestNPC [000002:Fallout4.esm]\nNon-Player Character\nFallout4.esm');
  });

  it('is labelled by its FormKey when it has no EditorID', async () => {
    const [referrer] = await referrersOver([reference({ formKey: '000002:Fallout4.esm' })]);
    expect(referrer?.label).toBe('000002:Fallout4.esm');
  });

  it('is one row however many plugins hold it, saying how many do', async () => {
    const referrers = await referrersOver([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', editorId: 'TestNPC' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', editorId: 'TestNPC' }),
    ]);
    expect(referrers).toHaveLength(1);
    expect(referrers[0]?.description).toBe('Non-Player Character · 2 plugins');
  });

  it('counts the plugins that hold it, not the fields that hold the reference', async () => {
    const [referrer] = await referrersOver([
      reference({ formKey: '000002:Fallout4.esm', fieldPath: 'Keywords[0]' }),
      reference({ formKey: '000002:Fallout4.esm', fieldPath: 'Keywords[1]' }),
    ]);
    expect(referrer?.description).toBe('Non-Player Character');
  });

  it('opens its winning copy on a click, carrying its record with no plugin as its Argument', async () => {
    const [referrer] = await referrersOver([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })]);
    const { command } = present(referrer, 'the referrer');
    expect(command?.command).toBe('modbench.record.open');
    expect(command?.arguments).toEqual([{ argument: { kind: 'record', formKey: '000002:Fallout4.esm' } }]);
    expect(recordOpenPlan(referrer, []).addresses).toEqual([{ formKey: '000002:Fallout4.esm' }]);
  });

  it('shows collapsed, with an identity of its own in each list, whatever record it is about', async () => {
    const client = indexed([reference({ formKey: '000002:Fallout4.esm' })]);
    const [first] = (await listOf(client, 'one list')).referrers;
    const [second] = (await listOf(client, 'another list')).referrers;
    expect([first?.collapsibleState, second?.collapsibleState])
      .toEqual([TreeItemCollapsibleState.Collapsed, TreeItemCollapsibleState.Collapsed]);
    expect(first?.id).not.toBe(second?.id);
  });

  it('is sorted by record type, then by label', async () => {
    const referrers = await referrersOver([
      reference({ formKey: '000004:Fallout4.esm', editorId: 'Zed', recordTypeName: 'Armor' }),
      reference({ formKey: '000002:Fallout4.esm', editorId: 'Beta', recordTypeName: 'Weapon' }),
      reference({ formKey: '000003:Fallout4.esm', editorId: 'Alpha', recordTypeName: 'Weapon' }),
      reference({ formKey: '000005:Fallout4.esm', recordTypeName: 'Armor' }),
    ]);
    expect(referrers.map((r) => r.label)).toEqual(['000005:Fallout4.esm', 'Zed', 'Alpha', 'Beta']);
  });
});

describe('the Referenced By list — where a referrer is held', () => {
  async function holdersOver(references: ReferenceResult[]) {
    const { provider, referrers: [referrer] } = await listOf(indexed(references));
    return provider.getChildren(present(referrer, 'the referrer')).filter(isHolder);
  }

  it('is one row per plugin, in the order mEdit answers, each naming its fields', async () => {
    const holders = await holdersOver([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'Keywords[0]' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Fallout4.esm', fieldPath: 'Keywords[1]' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', fieldPath: 'Template' }),
    ]);
    expect(holders.map(h => [h.label, h.description])).toEqual([
      ['Fallout4.esm', 'Keywords[0], Keywords[1]'],
      ['MyMod.esp', 'Template'],
    ]);
  });

  it('opens its plugin copy on a click', async () => {
    const [holder] = await holdersOver([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod' }),
    ]);
    expect(holder?.command?.command).toBe('modbench.record.open');
    expect(holder?.command?.arguments).toEqual([{ argument: holder?.argument }]);
  });

  it('keeps two plugins of one file name apart by their origins', async () => {
    const holders = await holdersOver([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Patch.esp', origin: 'ModA' }),
      reference({ formKey: '000002:Fallout4.esm', plugin: 'Patch.esp', origin: 'ModB' }),
    ]);
    expect(holders.map(h => h.plugin.origin)).toEqual(['ModA', 'ModB']);
    expect(new Set(holders.map(h => h.id)).size).toBe(2);
  });

  it('states the plugin copy it stands for, with its origin, the way copy and delete read it', async () => {
    const [holder] = await holdersOver([
      reference({ formKey: '000002:Fallout4.esm', plugin: 'MyMod.esp', origin: 'MyMod', editorId: 'TestNPC' }),
    ]);
    expect(holder).toMatchObject({
      argument: { kind: 'record', formKey: '000002:Fallout4.esm', plugin: { name: 'MyMod.esp', origin: 'MyMod' } },
    });
  });
});

describe('the Referenced By list — what a plugin copy offers', () => {
  const EDITABLE_MOD = 'EditableMod';
  const conditions: ConditionsOf = ({ origin }) =>
    origin === EDITABLE_MOD ? { tracked: true, editable: true } : { tracked: origin === 'TrackedMod', editable: false };
  const HOLDS_CHILDREN = [{ type: 'dial', displayName: 'Dialog Topic' }];

  async function listedAs(references: ReferenceResult[], children: typeof HOLDS_CHILDREN) {
    const client = indexed(references);
    client.setQueryAnswer('getChildRecordTypes', children);
    const { provider, referrers: [referrer] } = await listOf(client, 'a list', conditions);
    return { client, offers: provider.getChildren(present(referrer, 'the referrer')).map((holder) => holder.contextValue) };
  }

  it.each([
    ['an editable tracked plugin, for a record that can hold a child', EDITABLE_MOD, HOLDS_CHILDREN, 'referencedByHolder tracked editable container'],
    ['an editable tracked plugin, for a record that can hold none', EDITABLE_MOD, [], 'referencedByHolder tracked editable'],
    ['a tracked plugin that is not editable', 'TrackedMod', HOLDS_CHILDREN, 'referencedByHolder tracked'],
    ['a plugin of neither kind', 'Fallout4.esm', HOLDS_CHILDREN, 'referencedByHolder untracked'],
  ])('is stated as Plugins states it for %s', async (_, origin, children, expected) => {
    expect((await listedAs([reference({ formKey: '000002:Fallout4.esm', origin })], children)).offers).toEqual([expected]);
  });

  it('asks what a record can hold of an editable tracked plugin\'s copy only', async () => {
    const { client } = await listedAs([
      reference({ formKey: '000002:Fallout4.esm', origin: EDITABLE_MOD, plugin: 'E.esp' }),
      reference({ formKey: '000002:Fallout4.esm', origin: 'TrackedMod' }),
      reference({ formKey: '000002:Fallout4.esm', origin: 'Fallout4.esm' }),
    ], HOLDS_CHILDREN);
    expect(client.calls.filter((c) => c.method === 'getChildRecordTypes')).toEqual([
      { method: 'getChildRecordTypes', args: [{ name: 'E.esp', origin: EDITABLE_MOD }, '000002:Fallout4.esm'] },
    ]);
  });

  it('offers no create where what the record can hold cannot be read, and logs it', async () => {
    const client = indexed([reference({ formKey: '000002:Fallout4.esm', origin: EDITABLE_MOD })]);
    client.setQueryFailure('getChildRecordTypes', { failed: 'refused', refusal: 'boom' });
    const log = leveledLog();
    const { provider } = await readReferencedBy(client, log, TARGET, 'a list', conditions);
    const [referrer] = provider.getChildren();
    expect(provider.getChildren(present(referrer, 'the referrer')).map((h) => h.contextValue)).toEqual(['referencedByHolder tracked editable']);
    expect(log.lines.warn).toHaveLength(1);
  });
});

describe('referencedByCopyValueText — the text of the selected rows', () => {
  const copiedFrom = (selected: readonly unknown[]) => referencedByCopyValueText(selected[0], selected);

  it('copies a referrer as EditorID [FormKey], or its FormKey alone with no EditorID', async () => {
    expect(copiedFrom(await referrersOver([reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' })])))
      .toBe('TestNPC [000002:Fallout4.esm]');
    expect(copiedFrom(await referrersOver([reference({ formKey: '000002:Fallout4.esm' })]))).toBe('000002:Fallout4.esm');
  });

  it('joins several selected rows one per line, in selection order', async () => {
    const [first, second] = await referrersOver([
      reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' }),
      reference({ formKey: '000003:Fallout4.esm', editorId: 'OtherNPC', fieldPath: 'Template' }),
    ]);
    expect(copiedFrom([present(second, 'the second referrer'), present(first, 'the first referrer')]))
      .toBe('TestNPC [000002:Fallout4.esm]\nOtherNPC [000003:Fallout4.esm]');
  });

  it('copies a row beneath a referrer as the record it holds', async () => {
    const { provider, referrers: [referrer] } = await listOf(indexed([
      reference({ formKey: '000002:Fallout4.esm', editorId: 'TestNPC' }),
    ]));
    const [holder] = provider.getChildren(present(referrer, 'the referrer'));
    expect(copiedFrom([present(holder, 'its plugin copy')])).toBe('TestNPC [000002:Fallout4.esm]');
  });

  it('falls back to the clicked row alone with nothing else selected', async () => {
    const [referrer] = await referrersOver([reference({ formKey: '000002:Fallout4.esm', editorId: 'Named' })]);
    expect(referencedByCopyValueText(referrer, undefined)).toBe('Named [000002:Fallout4.esm]');
  });

  it('defers on an invocation of another surface, so an adapter after it can run', () => {
    expect(referencedByCopyValueText(undefined, undefined)).toBeUndefined();
    expect(referencedByCopyValueText({ kind: 'mod' }, undefined)).toBeUndefined();
    expect(referencedByCopyValueText({ view: 'modbench.modList' }, undefined)).toBeUndefined();
  });
});
