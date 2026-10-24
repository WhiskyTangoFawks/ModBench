import { describe, it, expect, vi } from 'vitest';
import { completionsAt } from '../completion';
import type { CompareResult, RecordPage, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, fieldOf, type Field } from '../../test/comparison';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

const OWNER = '000801:Mod.esp';
const CHILD = '000802:Mod.esp';
const GUN = '000900:Mod.esp';

const record = (editorId: string | null, formKey: string, isWinner = true): RecordSummary => ({
  formKey, plugin: formKey.split(':')[1] ?? '', loadOrderIndex: 0, isWinner, editorId, origin: DATA_DIRECTORY_ORIGIN, workingTreeState: 'None',
  hasContainerChildren: false, hasParseFailure: false,
});

const reference = (name: string, validFormKeyTypes: string[] = ['WEAP']) => fieldOf({ name, type: 'formKey', validFormKeyTypes });

const asking = (fields: Field[], found: RecordSummary[] = [record('Gun', GUN)], held: Record<string, Field[]> = { [OWNER]: fields }) => ({
  getComparison: vi.fn((formKey: string): Promise<CompareResult | null> => {
    const own = held[formKey];
    return Promise.resolve(own ? comparisonOf(formKey, [{ plugin: 'Mod.esp', isWinner: true, fields: own }]) : null);
  }),
  searchRecords: vi.fn((): Promise<RecordPage> => Promise.resolve({ items: found, total: found.length })),
});

const completingAtBar = (client: Parameters<typeof completionsAt>[0]['client'], marked: string, reporter = recordingReporter()) =>
  completionsAt({ client, reporter }, marked.replace('|', ''), marked.indexOf('|'));

const documentOf = (members: string) => `{ "FormKey": "${OWNER}", ${members} }`;

describe('completionsAt (plugin-source.md, In the text editor, story 5)', () => {
  it('offers records by EditorID, inserting the FormKey', async () => {
    const found = await completingAtBar(asking([reference('Armor')]), documentOf('"Armor": "Gu|"'));

    expect(found?.items).toEqual([{ label: 'Gun', detail: GUN, insertText: GUN }]);
  });

  it('replaces the string between its quotes', async () => {
    const marked = documentOf('"Armor": "Gu|n"');
    const found = await completingAtBar(asking([reference('Armor')]), marked);

    expect(marked.replace('|', '').slice(found?.start, found?.end)).toBe('Gun');
  });

  it('labels a record without an EditorID by its FormKey', async () => {
    const found = await completingAtBar(asking([reference('Armor')], [record(null, GUN)]), documentOf('"Armor": "Gu|"'));

    expect(found?.items.map((item) => item.label)).toEqual([GUN]);
  });

  it('offers a record once, however many plugins hold a copy', async () => {
    const copies = [record('Gun', GUN, false), record('Gun', GUN)];
    const found = await completingAtBar(asking([reference('Armor')], copies), documentOf('"Armor": "Gu|"'));

    expect(found?.items).toHaveLength(1);
  });

  const keywords = fieldOf({ name: 'Keywords', type: 'array', isArray: true, elementType: reference('Keyword', ['KYWD']).metadata });
  const inStructs = fieldOf({
    name: 'Data', type: 'struct',
    fields: [fieldOf({ name: 'Inner', type: 'struct', fields: [reference('Ammo', ['AMMO']).metadata] }).metadata],
  });
  const owner = fieldOf({
    name: 'Owner', type: 'struct',
    fields: [
      fieldOf({ name: 'MutagenObjectType', type: 'string', isDiscriminator: true }).metadata,
      fieldOf({ name: 'Target', type: 'string', variants: { Spell: reference('Target', ['SPEL']).metadata, Perk: reference('Target', ['PERK']).metadata } }).metadata,
    ],
  });

  it.each<[string, Record<string, Field[]>, string, string[]]>([
    ['a reference field', { [OWNER]: [reference('Armor', ['WEAP', 'ARMO'])] }, documentOf('"Armor": "Gu|"'), ['WEAP', 'ARMO']],
    ['the element of an array of references', { [OWNER]: [keywords] }, documentOf('"Keywords": ["000001:Mod.esp", "Gu|"]'), ['KYWD']],
    ['a reference nested in structs', { [OWNER]: [inStructs] }, documentOf('"Data": { "Inner": { "Ammo": "Gu|" } }'), ['AMMO']],
    ['the member shape of the leaf the owner names', { [OWNER]: [owner] }, documentOf('"Owner": { "MutagenObjectType": "Perk", "Target": "Gu|" }'), ['PERK']],
    ['the nearest enclosing record, an embedded child with its own FormKey', { [CHILD]: [reference('Base', ['STAT'])] },
      documentOf(`"Placed": [{ "FormKey": "${CHILD}", "Base": "Gu|" }]`), ['STAT']],
  ])('searches the typed text, in %s, among the types the field allows', async (_case, held, marked, types) => {
    const client = asking([], [record('Gun', GUN)], held);

    await completingAtBar(client, marked);

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', types);
  });

  const alias = fieldOf({
    name: 'Data', type: 'struct',
    fields: [fieldOf({ name: 'Target', type: 'formKey', validFormKeyTypes: ['REFR'], indexWhen: ['UseAliases'] }).metadata],
  });

  it.each<[string, Record<string, Field[]>, string]>([
    ['a reference its owner says names an alias, which holds a number', { [OWNER]: [alias] }, documentOf('"Data": { "UseAliases": true, "Target": "Gu|" }')],
    ['a field that is not a reference', { [OWNER]: [fieldOf({ name: 'Name', type: 'string' })] }, documentOf('"Name": "Gu|"')],
    ['a member the record does not declare', { [OWNER]: [reference('Armor')] }, documentOf('"Unknown": "Gu|"')],
    ['a property name', { [OWNER]: [reference('Armor')] }, documentOf('"Ar|": 1')],
    ['a string before anything is typed', { [OWNER]: [reference('Armor')] }, documentOf('"Armor": "|"')],
    ['a record the record index does not hold', {}, documentOf('"Armor": "Gu|"')],
    ['a place outside a record', { [OWNER]: [reference('Armor')] }, '{ "Armor": "Gu|" }'],
  ])('offers nothing for %s', async (_case, held, marked) => {
    expect(await completingAtBar(asking([], [record('Gun', GUN)], held), marked)).toBeUndefined();
  });

  describe('inside an enum field', () => {
    const members = [{ value: 'Auto', label: 'Automatic' }, { value: 'Single' }];
    const enumField = fieldOf({ name: 'Mode', type: 'enum', enumMembers: members });
    const flagsField = fieldOf({
      name: 'Flags', type: 'flags',
      enumMembers: [{ value: 'Silent', bitValue: '1' }, { value: 'Loud', bitValue: '2', label: 'Noisy' }],
    });

    it('offers its values as the document spells them, before anything is typed', async () => {
      const client = asking([enumField]);
      const found = await completingAtBar(client, documentOf('"Mode": "|"'));

      expect(found?.items).toEqual([
        { label: 'Auto', detail: 'Automatic', insertText: 'Auto' },
        { label: 'Single', detail: '', insertText: 'Single' },
      ]);
    });

    it('replaces the string between its quotes', async () => {
      const marked = documentOf('"Mode": "Si|ng"');
      const found = await completingAtBar(asking([enumField]), marked);

      expect(marked.replace('|', '').slice(found?.start, found?.end)).toBe('Sing');
    });

    it('offers one flag as an element of the array the document writes', async () => {
      const found = await completingAtBar(asking([flagsField]), documentOf('"Flags": ["Silent", "|"]'));

      expect(found?.items.map((item) => item.insertText)).toEqual(['Silent', 'Loud']);
    });

    it('offers the values of an enum nested in structs', async () => {
      const data = fieldOf({ name: 'Data', type: 'struct', fields: [enumField.metadata] });
      const found = await completingAtBar(asking([data]), documentOf('"Data": { "Mode": "|" }'));

      expect(found?.items.map((item) => item.insertText)).toEqual(['Auto', 'Single']);
    });

    it('offers nothing in a property name', async () => {
      expect(await completingAtBar(asking([enumField]), documentOf('"Mo|": 1'))).toBeUndefined();
    });

    it('offers nothing for a string field that has no members', async () => {
      expect(await completingAtBar(asking([fieldOf({ name: 'Mode', type: 'string' })]), documentOf('"Mode": "|"'))).toBeUndefined();
    });
  });

  it.each([
    ['the record\'s comparison', { getComparison: () => Promise.reject(new Error('mEdit is down.')) }],
    ['the search', { searchRecords: () => Promise.reject(new Error('mEdit is down.')) }],
  ])('writes why to the Output, and offers nothing, when mEdit cannot answer %s', async (_, failing) => {
    const reporter = recordingReporter();
    const client = { ...asking([reference('Armor')]), ...failing };

    const found = await completingAtBar(client, documentOf('"Armor": "Gu|"'), reporter);

    expect(found).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Completion cannot list what ${OWNER} offers here.`, detail: 'mEdit is down.' }]);
  });
});
