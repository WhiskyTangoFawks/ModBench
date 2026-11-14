import { describe, expect, it, vi } from 'vitest';
import { sourceNames } from '../sourceNames';
import type { DocumentName, MEditClient, RecordSummary } from '../../client';
import { recordingReporter } from '../../test/surfacingDoubles';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import { localFailure, type ReadFailed } from '../../wire/readFailed';

const NPC = '000801:Mod.esp';
const GUN = '000900:Mod.esp';
const FILE = '/instance/source/Mod/plugin-source/Mod.esp/Npc.json';
const TEXT = '{ "FormKey": "000801:Mod.esp", "Armor": "Gu" }';

const named = (kind: DocumentName['kind'], start: number, end: number, value: string, over: Partial<DocumentName> = {}): DocumentName =>
  ({ kind, start, end, value, record: NPC, fieldPath: 'Armor', ...over });

const OWN = named('Record', 13, 29, NPC, { fieldPath: 'FormKey' });

const record = (editorId: string | null, formKey: string): RecordSummary => ({
  formKey, plugin: 'Mod.esp', loadOrderIndex: 0, isWinner: true, editorId, origin: DATA_DIRECTORY_ORIGIN, workingTreeState: 'None',
  hasContainerChildren: false, hasParseFailure: false,
});

function names(answer: DocumentName[] | ReadFailed, found: RecordSummary[] = [record('Gun', GUN)]) {
  const reporter = recordingReporter();
  const client = {
    getPluginSourceNames: vi.fn<MEditClient['getPluginSourceNames']>(() => Promise.resolve(answer)),
    searchRecords: vi.fn<MEditClient['searchRecords']>(() => Promise.resolve({ items: found, total: found.length })),
  };
  return { owner: sourceNames({ client, names: client, reporter }), client, reporter };
}

describe('the names at a place in plugin source, as mEdit answers them (target-architecture.md)', () => {
  it('answers each kind the name of that kind at a place, asking with its file', async () => {
    const { owner, client } = names([named('Script', 40, 42, 'Gu')]);

    const answers = [await owner.recordAt(FILE, TEXT, 41), await owner.scriptAt(FILE, TEXT, 41)];

    expect([answers, client.getPluginSourceNames.mock.calls[0]]).toEqual([[undefined, { start: 40, end: 42, name: 'Gu' }], [TEXT, FILE, 41]]);
  });

  it('tells the Output once of a place mEdit cannot answer for, however many kinds ask of it', async () => {
    const { owner, reporter } = names(localFailure('mEdit is down'));

    await owner.recordAt(FILE, TEXT, 20);
    await owner.scriptAt(FILE, TEXT, 20);

    expect(reporter.shownFailures).toHaveLength(1);
  });

  it.each([
    ['the file, by its path in the Data folder', named('File', 1, 4, 'a.dds', { dataPath: 'Textures/a.dds' }), { start: 1, end: 4, given: 'a.dds', path: 'Textures/a.dds' }],
    ['no file, saying why', named('File', 1, 4, 'Data/a.dds', { refusal: 'It is no path a texture holds.' }), { start: 1, end: 4, given: 'Data/a.dds', refused: 'It is no path a texture holds.' }],
  ])('names, at a path, %s', async (_case, name, expected) => {
    expect(await names([name]).owner.fileAt(FILE, TEXT, 2)).toEqual(expected);
  });

  it('names nothing where mEdit cannot answer, and the Output says why', async () => {
    const { owner, reporter } = names(localFailure('mEdit is down'));

    expect(await owner.recordAt(FILE, TEXT, 20)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: 'Cannot tell what plugin source names here.', detail: 'mEdit is down' }]);
  });
});

describe('the records a reference field offers (symbols.md, The features, story 5)', () => {
  const REFERENCE = named('Reference', 41, 43, 'Gu', { validFormKeyTypes: ['ARMO', 'WEAP'] });

  it('searches the text typed so far among the types the field allows, offering each record once, by EditorID or FormKey', async () => {
    const { owner, client } = names([REFERENCE], [record('Gun', GUN), record('Gun', GUN), record(null, '000901:Mod.esp')]);

    expect(await owner.recordsOfferedAt(FILE, TEXT, 43)).toEqual({
      start: 41, end: 43, items: [{ label: 'Gun', detail: GUN, insertText: GUN }, { label: '000901:Mod.esp', detail: '000901:Mod.esp', insertText: '000901:Mod.esp' }],
    });
    expect(client.searchRecords.mock.calls).toEqual([['Gu', ['ARMO', 'WEAP']]]);
  });

  it('offers nothing before anything is typed', async () => {
    expect(await names([REFERENCE]).owner.recordsOfferedAt(FILE, TEXT, 41)).toBeUndefined();
  });

  it('offers nothing where mEdit cannot search, and the Output says why', async () => {
    const { owner, client, reporter } = names([REFERENCE]);
    client.searchRecords.mockRejectedValue(new Error('mEdit is down.'));

    expect(await owner.recordsOfferedAt(FILE, TEXT, 43)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Completion cannot list what ${NPC} offers here.`, detail: 'mEdit is down.' }]);
  });
});

describe('the FormKey or EditorID Rename Symbol changes (symbols.md, The symbols, Record)', () => {
  it.each([
    ['a FormKey, between its quotes, with the plugin inside it', [OWN, named('Plugin', 21, 28, 'Mod.esp', { fieldPath: 'FormKey' })],
      { start: 14, end: 28, formKey: NPC, member: 'FormKey', plugin: { name: 'Mod.esp' } }],
    ['an EditorID, of the record that holds it', [named('EditorId', 40, 43, 'Npc', { fieldPath: 'EditorID' })], { start: 40, end: 43, formKey: NPC, member: 'EditorID' }],
    ['none elsewhere', [named('Reference', 40, 42, 'Gu')], undefined],
  ])('is %s', async (_case, answer, expected) => {
    expect(await names(answer).owner.recordMemberAt(FILE, TEXT, 20)).toEqual(expected);
  });
});

describe('where a copy\'s document names a symbol, asked of its text alone', () => {
  const REFERENCE = named('Record', 40, 56, GUN);
  const OTHER = named('Record', 60, 76, GUN, { record: '000802:Mod.esp' });

  it.each([
    ['at its reference, past another record\'s', [OWN, OTHER, REFERENCE], { start: 40, end: 56 }],
    ['at the referrer\'s own FormKey where it holds no reference', [OWN, OTHER], { start: 13, end: 29 }],
    ['at the start of the text where the referrer is absent', [OTHER], { start: 0, end: 0 }],
  ])('a record references one %s', async (_case, answer, expected) => {
    const { owner, client } = names(answer);

    expect(await owner.referenceIn(TEXT, NPC, GUN)).toEqual(expected);
    expect(client.getPluginSourceNames.mock.calls).toEqual([[TEXT]]);
  });

  it('lists a record that references itself at the field that holds the reference, never at its own FormKey', async () => {
    const { owner } = names([OWN, named('Record', 40, 56, NPC, { fieldPath: 'Template' })]);

    expect(await owner.referenceIn(TEXT, NPC, NPC)).toEqual({ start: 40, end: 56 });
  });

  it.each([
    ['at each FormKey of it that names the plugin', [OWN, named('Plugin', 48, 55, 'base.ESM'), named('Plugin', 70, 77, 'Base.esm', { record: GUN })], [{ start: 48, end: 55 }]],
    ['at its own FormKey where none does', [OWN], [{ start: 13, end: 29 }]],
    ['at the start of the text where the record is absent', [], [{ start: 0, end: 0 }]],
  ])('a record names a plugin %s', async (_case, answer, expected) => {
    expect(await names(answer).owner.pluginNamesIn(TEXT, NPC, 'Base.esm')).toEqual(expected);
  });

  it('names a script or a file at each of the member paths mEdit gives', async () => {
    const answer = [named('Script', 40, 45, 'Ns:Q', { fieldPath: 'Scripts[0].Name' }), named('File', 50, 55, 'a.dds', { fieldPath: 'Diffuse' }),
      named('Script', 60, 65, 'Ns:Q', { fieldPath: 'Scripts[0].Name', record: GUN })];

    expect(await names(answer).owner.membersIn(TEXT, NPC, ['Scripts[0].Name', 'Diffuse'])).toEqual([{ start: 40, end: 45 }, { start: 50, end: 55 }]);
  });

  it('answers a record\'s own FormKey member and its own FormKey', async () => {
    const { owner } = names([named('Declaration', 2, 29, NPC, { fieldPath: 'FormKey' }), OWN]);

    expect([await owner.declarationIn(TEXT, NPC), await owner.formKeyIn(TEXT, NPC)]).toEqual([{ start: 2, end: 29 }, { start: 13, end: 29 }]);
  });

  it('fails where mEdit cannot answer, for the caller to say which copy went unread', async () => {
    await expect(names(localFailure('mEdit is down')).owner.formKeyIn(TEXT, NPC)).rejects.toThrow('mEdit is down');
  });
});
