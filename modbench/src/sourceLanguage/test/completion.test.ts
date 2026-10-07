import { describe, it, expect, vi } from 'vitest';
import { completionsAt } from '../completion';
import type { CompareResult, RecordSummary } from '../../client';
type RecordPage = { items: RecordSummary[]; total: number };
import { comparisonOf, fieldOf, type Field } from '../../test/comparison';

const OWNER = '000801:Mod.esp';
const CHILD = '000802:Mod.esp';
const GUN = '000900:Mod.esp';

const record = (editorId: string | null, formKey: string, isWinner = true): RecordSummary => ({
  formKey, plugin: formKey.split(':')[1] ?? '', loadOrderIndex: 0, isWinner, editorId, origin: 'Data', workingTreeState: 'None',
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

const completingAtBar = (client: ReturnType<typeof asking>, marked: string) =>
  completionsAt(client, marked.replace('|', ''), marked.indexOf('|'));

const documentOf = (members: string) => `{ "FormKey": "${OWNER}", ${members} }`;

describe('completionsAt (plugin-source.md, In the text editor, story 5)', () => {
  it('offers records by EditorID, inserting the FormKey', async () => {
    const found = await completingAtBar(asking([reference('Armor')]), documentOf('"Armor": "Gu|"'));

    expect(found?.items).toEqual([{ label: 'Gun', detail: GUN, insertText: GUN }]);
  });

  it('searches the typed text among the types the field allows', async () => {
    const client = asking([reference('Armor', ['WEAP', 'ARMO'])]);
    await completingAtBar(client, documentOf('"Armor": "Gu|"'));

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', ['WEAP', 'ARMO']);
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

  it('completes the element of an array of references', async () => {
    const keywords = fieldOf({ name: 'Keywords', type: 'array', isArray: true, elementType: reference('Keyword', ['KYWD']).metadata });
    const client = asking([keywords]);
    await completingAtBar(client, documentOf('"Keywords": ["000001:Mod.esp", "Gu|"]'));

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', ['KYWD']);
  });

  it('completes a reference nested in structs', async () => {
    const inner = fieldOf({ name: 'Inner', type: 'struct', fields: [reference('Ammo', ['AMMO']).metadata] });
    const data = fieldOf({ name: 'Data', type: 'struct', fields: [inner.metadata] });
    const client = asking([data]);
    await completingAtBar(client, documentOf('"Data": { "Inner": { "Ammo": "Gu|" } }'));

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', ['AMMO']);
  });

  it('takes the member shape of the leaf the owner names', async () => {
    const discriminator = fieldOf({ name: 'MutagenObjectType', type: 'string', isDiscriminator: true }).metadata;
    const target = fieldOf({
      name: 'Target', type: 'string',
      variants: { Spell: reference('Target', ['SPEL']).metadata, Perk: reference('Target', ['PERK']).metadata },
    }).metadata;
    const client = asking([fieldOf({ name: 'Owner', type: 'struct', fields: [discriminator, target] })]);
    await completingAtBar(client, documentOf('"Owner": { "MutagenObjectType": "Perk", "Target": "Gu|" }'));

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', ['PERK']);
  });

  it('completes within the nearest enclosing record, an embedded child with its own FormKey', async () => {
    const client = asking([], [record('Gun', GUN)], { [CHILD]: [reference('Base', ['STAT'])] });
    await completingAtBar(client, documentOf(`"Placed": [{ "FormKey": "${CHILD}", "Base": "Gu|" }]`));

    expect(client.getComparison).toHaveBeenCalledWith(CHILD);
    expect(client.searchRecords).toHaveBeenCalledWith('Gu', ['STAT']);
  });

  it('offers nothing for a field that is not a reference', async () => {
    const client = asking([fieldOf({ name: 'Name', type: 'string' })]);

    expect(await completingAtBar(client, documentOf('"Name": "Gu|"'))).toBeUndefined();
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('offers nothing for a member the record does not declare', async () => {
    const client = asking([reference('Armor')]);

    expect(await completingAtBar(client, documentOf('"Unknown": "Gu|"'))).toBeUndefined();
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('offers nothing in a property name', async () => {
    const client = asking([reference('Armor')]);

    expect(await completingAtBar(client, documentOf('"Ar|": 1'))).toBeUndefined();
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('offers nothing before anything is typed', async () => {
    const client = asking([reference('Armor')]);

    expect(await completingAtBar(client, documentOf('"Armor": "|"'))).toBeUndefined();
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('offers nothing for a record the index does not hold', async () => {
    const client = asking([reference('Armor')], [record('Gun', GUN)], {});

    expect(await completingAtBar(client, documentOf('"Armor": "Gu|"'))).toBeUndefined();
    expect(client.searchRecords).not.toHaveBeenCalled();
  });

  it('offers nothing outside a record', async () => {
    const client = asking([reference('Armor')]);

    expect(await completingAtBar(client, '{ "Armor": "Gu|" }')).toBeUndefined();
    expect(client.getComparison).not.toHaveBeenCalled();
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
      expect(client.searchRecords).not.toHaveBeenCalled();
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
});
