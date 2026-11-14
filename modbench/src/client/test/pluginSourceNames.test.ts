import { describe, it, expect, vi } from 'vitest';
import { pluginSourceNames, type PluginSourceClient } from '../pluginSourceNames';
import type { CompareResult, RecordPage, RecordSummary } from '..';
import { recordingReporter } from '../../test/surfacingDoubles';
import { comparisonOf, fieldOf, type Field } from '../../test/comparison';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import { localFailure } from '../../wire/readFailed';

const OWNER = '000801:Mod.esp';
const CHILD = '000802:Mod.esp';
const GUN = '000900:Mod.esp';
const SOURCE = '/instance/source/Mod/plugin-source/Mod.esp/Record.json';
const NOT_SOURCE = '/instance/notes.json';

const record = (editorId: string | null, formKey: string, isWinner = true): RecordSummary => ({
  formKey, plugin: formKey.split(':')[1] ?? '', loadOrderIndex: 0, isWinner, editorId, origin: DATA_DIRECTORY_ORIGIN, workingTreeState: 'None',
  hasContainerChildren: false, hasParseFailure: false,
});

const reference = (name: string, validFormKeyTypes: string[] = ['WEAP']) => fieldOf({ name, type: 'formKey', validFormKeyTypes });

interface Asked {
  held?: Record<string, Field[]>;
  found?: RecordSummary[];
  resolve?: PluginSourceClient['resolveFilePath'];
  failing?: Partial<PluginSourceClient>;
}

function names({ held = {}, found = [record('Gun', GUN)], resolve = () => Promise.resolve('textures/decals/stain_d.dds'), failing = {} }: Asked = {}) {
  const reporter = recordingReporter();
  const resolveFilePath = vi.fn(resolve);
  const client = {
    getComparison: vi.fn((formKey: string): Promise<CompareResult | null> => {
      const own = held[formKey];
      return Promise.resolve(own ? comparisonOf(formKey, [{ plugin: 'Mod.esp', recordType: 'txst', isWinner: true, fields: own }]) : null);
    }),
    searchRecords: vi.fn((): Promise<RecordPage> => Promise.resolve({ items: found, total: found.length })),
    resolveFilePath,
    ...failing,
  };
  const owner = pluginSourceNames({ client, reporter, isPluginSource: (path) => path === SOURCE, gameRelease: () => Promise.resolve('Fallout4') });
  return { owner, client, resolveFilePath, reporter };
}

const at = (marked: string) => ({ text: marked.replace('|', ''), offset: marked.indexOf('|') });
const documentOf = (members: string) => `{ "FormKey": "${OWNER}", ${members} }`;
const spanned = (text: string, span: { start: number; end: number } | undefined) => text.slice(span?.start, span?.end);

describe('a record\'s FormKey in plugin source (symbols.md, The symbols, Record)', () => {
  it('names the record, spanning the FormKey string, quotes included', () => {
    const { text, offset } = at(documentOf(`"Armor": "00|0900:Mod.esp"`));
    const found = names().owner.recordAt(SOURCE, text, offset);

    expect([found?.formKey, spanned(text, found)]).toEqual([GUN, `"${GUN}"`]);
  });

  it.each([
    ['a string that is not a FormKey', SOURCE, '{ "Name": "Rus|ty Gun" }'],
    ['a FormKey spelled as a property name', SOURCE, `{ "00|0900:Mod.esp": 1 }`],
    ['a place outside a string', SOURCE, `{| "A": "${GUN}" }`],
    ['a FormKey in a file that is no plugin source', NOT_SOURCE, `{ "A": "00|0900:Mod.esp" }`],
  ])('names nothing at %s', (_case, file, marked) => {
    const { text, offset } = at(marked);

    expect(names().owner.recordAt(file, text, offset)).toBeUndefined();
  });
});

describe('a plugin\'s name inside a FormKey in plugin source (symbols.md, The symbols, Plugin)', () => {
  it.each([
    ['names the plugin by its file name alone', SOURCE, { name: 'Mod.esp' }],
    ['names nothing in a file that is no plugin source', NOT_SOURCE, undefined],
  ])('%s', async (_case, file, expected) => {
    const { text, offset } = at(documentOf(`"Armor": "000900:Mo|d.esp"`));

    expect(await names().owner.pluginAt(file, text, offset)).toEqual(expected);
  });
});

describe('a Papyrus script\'s name in plugin source (symbols.md, The symbols)', () => {
  const adapter = fieldOf({
    name: 'VirtualMachineAdapter', type: 'struct', fields: [fieldOf({
      name: 'Scripts', type: 'array', isArray: true, elementType: fieldOf({
        name: 'Script', type: 'struct', fields: [
          fieldOf({ name: 'Name', type: 'string', isScriptName: true }).metadata,
          fieldOf({ name: 'Properties', type: 'array', isArray: true, elementType: fieldOf({ name: 'Property', type: 'struct', fields: [fieldOf({ name: 'Name', type: 'string' }).metadata] }).metadata }).metadata,
        ],
      }).metadata,
    }).metadata],
  });
  const scripted = (script: string, property = 'Count') =>
    documentOf(`"VirtualMachineAdapter": { "Scripts": [ { "Name": "${script}", "Properties": [ { "Name": "${property}" } ] } ] }`);

  it('spans its name between its quotes', async () => {
    const { text, offset } = at(scripted('Ns:Q|uest'));
    const found = await names({ held: { [OWNER]: [adapter] } }).owner.scriptAt(SOURCE, text, offset);

    expect([found?.name, spanned(text, found)]).toEqual(['Ns:Quest', 'Ns:Quest']);
  });

  it.each([
    ['a property\'s name', SOURCE, scripted('Ns:Quest', 'Co|unt')],
    ['a record\'s FormKey', SOURCE, documentOf(`"VirtualMachineAdapter": { "Scripts": [ { "Name": "00|0900:Mod.esp" } ] }`)],
    ['an empty name', SOURCE, scripted('|')],
    ['a file that is no plugin source', NOT_SOURCE, scripted('Ns:Q|uest')],
  ])('is not %s', async (_case, file, marked) => {
    const { text, offset } = at(marked);

    expect(await names({ held: { [OWNER]: [adapter] } }).owner.scriptAt(file, text, offset)).toBeUndefined();
  });

  it('says why it cannot tell, when mEdit cannot answer for the record', async () => {
    const { text, offset } = at(scripted('Ns:Q|uest'));
    const { owner, reporter } = names({ failing: { getComparison: () => Promise.reject(new Error('mEdit is down')) } });

    expect(await owner.scriptAt(SOURCE, text, offset)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Cannot tell whether ${OWNER} names a Papyrus script here.`, detail: 'mEdit is down' }]);
  });
});

describe('a path in plugin source names a file (symbols.md, The symbols, File)', () => {
  const PATHED = { [OWNER]: [fieldOf({ name: 'Diffuse', type: 'string', isAssetLink: true }), fieldOf({ name: 'EditorID', type: 'string' })] };
  const TEXT = documentOf('"Diffuse": "Decals\\\\Stain_d.dds", "EditorID": "Stain"');
  const NAMED = TEXT.indexOf('Decals') + 2;
  const SPAN = { start: TEXT.indexOf('Decals'), end: TEXT.indexOf('Decals') + 'Decals\\\\Stain_d.dds'.length };

  it('names the file by its path in the Data folder, asking mEdit which file the record\'s path names', async () => {
    const { owner, resolveFilePath } = names({ held: PATHED });

    expect(await owner.fileAt(SOURCE, TEXT, NAMED)).toEqual({ ...SPAN, given: 'Decals\\Stain_d.dds', path: 'textures/decals/stain_d.dds' });
    expect(resolveFilePath.mock.calls).toEqual([['Fallout4', 'txst', JSON.stringify(JSON.parse(TEXT)), 'Diffuse']]);
  });

  it('names none, saying why, where mEdit could not tell which file the path names', async () => {
    const { owner } = names({ held: PATHED, resolve: () => Promise.resolve(localFailure('Data/Stain_d.dds is no path its asset type holds')) });

    expect(await owner.fileAt(SOURCE, TEXT, NAMED)).toEqual({ ...SPAN, given: 'Decals\\Stain_d.dds', refused: 'Data/Stain_d.dds is no path its asset type holds' });
  });

  it('says why it cannot tell whether the field is a path, when mEdit cannot answer for the record', async () => {
    const { owner, resolveFilePath, reporter } = names({ failing: { getComparison: () => Promise.reject(new Error('mEdit is down')) } });

    expect(await owner.fileAt(SOURCE, TEXT, NAMED)).toBeUndefined();
    expect([resolveFilePath.mock.calls, reporter.shownFailures]).toEqual([[], [{ severity: 'error', message: `Cannot tell whether ${OWNER} names a file here.`, detail: 'mEdit is down' }]]);
  });

  it.each([
    ['a field that is no path', SOURCE, TEXT.lastIndexOf('Stain') + 2],
    ['a path in a file that is no plugin source', NOT_SOURCE, NAMED],
  ])('is not %s', async (_case, file, offset) => {
    const { owner, resolveFilePath } = names({ held: PATHED });

    expect(await owner.fileAt(file, TEXT, offset)).toBeUndefined();
    expect(resolveFilePath).not.toHaveBeenCalled();
  });
});

describe('the records a reference field offers (symbols.md, The features, story 5)', () => {
  const offered = (asked: Asked, marked: string, file = SOURCE) => {
    const { text, offset } = at(marked);
    return names(asked).owner.recordsOfferedAt(file, text, offset);
  };

  it('offers records by EditorID, inserting the FormKey', async () => {
    const found = await offered({ held: { [OWNER]: [reference('Armor')] } }, documentOf('"Armor": "Gu|"'));

    expect(found?.items).toEqual([{ label: 'Gun', detail: GUN, insertText: GUN }]);
  });

  it('replaces the string between its quotes', async () => {
    const marked = documentOf('"Armor": "Gu|n"');
    const found = await offered({ held: { [OWNER]: [reference('Armor')] } }, marked);

    expect(spanned(marked.replace('|', ''), found)).toBe('Gun');
  });

  it('labels a record without an EditorID by its FormKey', async () => {
    const found = await offered({ held: { [OWNER]: [reference('Armor')] }, found: [record(null, GUN)] }, documentOf('"Armor": "Gu|"'));

    expect(found?.items.map((item) => item.label)).toEqual([GUN]);
  });

  it('offers a record once, however many plugins hold a copy', async () => {
    const found = await offered({ held: { [OWNER]: [reference('Armor')] }, found: [record('Gun', GUN, false), record('Gun', GUN)] }, documentOf('"Armor": "Gu|"'));

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
    const { owner: names_, client } = names({ held });
    const { text, offset } = at(marked);

    await names_.recordsOfferedAt(SOURCE, text, offset);

    expect(client.searchRecords).toHaveBeenCalledWith('Gu', types);
  });

  const alias = fieldOf({
    name: 'Data', type: 'struct',
    fields: [fieldOf({ name: 'Target', type: 'formKey', validFormKeyTypes: ['REFR'], indexWhen: ['UseAliases'] }).metadata],
  });

  it.each<[string, Record<string, Field[]>, string, string]>([
    ['a reference its owner says names an alias, which holds a number', { [OWNER]: [alias] }, documentOf('"Data": { "UseAliases": true, "Target": "Gu|" }'), SOURCE],
    ['a field that is not a reference', { [OWNER]: [fieldOf({ name: 'Name', type: 'string' })] }, documentOf('"Name": "Gu|"'), SOURCE],
    ['a member the record does not declare', { [OWNER]: [reference('Armor')] }, documentOf('"Unknown": "Gu|"'), SOURCE],
    ['a property name', { [OWNER]: [reference('Armor')] }, documentOf('"Ar|": 1'), SOURCE],
    ['a string before anything is typed', { [OWNER]: [reference('Armor')] }, documentOf('"Armor": "|"'), SOURCE],
    ['a record the record index does not hold', {}, documentOf('"Armor": "Gu|"'), SOURCE],
    ['a place outside a record', { [OWNER]: [reference('Armor')] }, '{ "Armor": "Gu|" }', SOURCE],
    ['a file that is no plugin source', { [OWNER]: [reference('Armor')] }, documentOf('"Armor": "Gu|"'), NOT_SOURCE],
  ])('offers nothing for %s', async (_case, held, marked, file) => {
    expect(await offered({ held }, marked, file)).toBeUndefined();
  });

  it.each([
    ['the record\'s comparison', { getComparison: () => Promise.reject(new Error('mEdit is down.')) }],
    ['the search', { searchRecords: () => Promise.reject(new Error('mEdit is down.')) }],
  ])('writes why to the Output, and offers nothing, when mEdit cannot answer %s', async (_, failing) => {
    const { owner: names_, reporter } = names({ held: { [OWNER]: [reference('Armor')] }, failing });
    const { text, offset } = at(documentOf('"Armor": "Gu|"'));

    expect(await names_.recordsOfferedAt(SOURCE, text, offset)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Completion cannot list what ${OWNER} offers here.`, detail: 'mEdit is down.' }]);
  });
});

describe('the FormKey or EditorID Rename Symbol changes on its record (symbols.md, The symbols, Record)', () => {
  const TEXT = '{ "FormKey": "000800:Patch.esp", "EditorID": "PatchNpc", "Race": "000801:Base.esm", "Name": "Npc" }';

  it.each([
    ['a FormKey a record links, naming its plugin by its file name', '000801', { formKey: '000801:Base.esm', member: 'FormKey', plugin: { name: 'Base.esm' } }, '000801:Base.esm'],
    ['the EditorID, of the record that holds it', 'PatchNpc', { formKey: '000800:Patch.esp', member: 'EditorID' }, 'PatchNpc'],
  ])('is %s, between its quotes', (_case, snippet, member, placeholder) => {
    const found = names().owner.recordMemberAt(SOURCE, TEXT, TEXT.indexOf(snippet) + 2);

    expect(found).toMatchObject(member);
    expect(spanned(TEXT, found)).toBe(placeholder);
  });

  it.each([
    ['another field of plugin source', SOURCE, '"Npc"'],
    ['a FormKey in a file that is no plugin source', NOT_SOURCE, '000801'],
  ])('is none on %s', (_case, file, snippet) => {
    expect(names().owner.recordMemberAt(file, TEXT, TEXT.indexOf(snippet) + 2)).toBeUndefined();
  });
});
