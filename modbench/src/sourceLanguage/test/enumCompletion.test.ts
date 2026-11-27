import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { sourceLanguageOver } from './sourceLanguageOver';
import { comparisonOf, fieldOf, type Field } from '../../test/comparison';
import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';

const OWNER = '000801:Mod.esp';
const CHILD = '000802:Mod.esp';
const SOURCE = '/source/ModA/plugin-source/Mod.esp/Npc.json';

function completing(fields: Field[]) {
  const made = sourceLanguageOver({
    arrange: (client) => { client.setQueryAnswer('getComparison', comparisonOf(OWNER, [{ plugin: 'Mod.esp', origin: DATA_DIRECTORY_ORIGIN, isWinner: true, fields }])); },
  });
  const asked = () => made.client.calls.filter(({ method }) => method === 'getComparison').map(({ args }) => args[0]);
  return { ...made, asked, at: (marked: string, path = SOURCE) => host.complete(path, marked) };
}

const documentOf = (members: string, formKey = OWNER) => `{ "FormKey": "${formKey}", ${members} }`;

describe('completing an enum or flags value in plugin source (source.md, Editing plugin source, story 2)', () => {
  const members = [{ value: 'Auto', label: 'Automatic' }, { value: 'Single' }];
  const enumField = fieldOf({ name: 'Mode', type: 'enum', enumMembers: members });
  const flagsField = fieldOf({
    name: 'Flags', type: 'flags',
    enumMembers: [{ value: 'Silent', bitValue: '1' }, { value: 'Loud', bitValue: '2', label: 'Noisy' }],
  });

  it('offers its values as the document spells them, before anything is typed', async () => {
    expect(await completing([enumField]).at(documentOf('"Mode": "|"'))).toEqual([
      { label: 'Auto', detail: 'Automatic', insertText: 'Auto', replaces: '' },
      { label: 'Single', detail: '', insertText: 'Single', replaces: '' },
    ]);
  });

  it('replaces the string between its quotes', async () => {
    const found = await completing([enumField]).at(documentOf('"Mode": "Si|ng"'));

    expect(found.map(({ replaces }) => replaces)).toEqual(['Sing', 'Sing']);
  });

  it.each([
    ['one flag as an element of the array the document writes', [flagsField], documentOf('"Flags": ["Silent", "|"]'), ['Silent', 'Loud']],
    ['the values of an enum nested in structs', [fieldOf({ name: 'Data', type: 'struct', fields: [enumField.metadata] })], documentOf('"Data": { "Mode": "|" }'), ['Auto', 'Single']],
  ])('offers %s', async (_case, fields, marked, offered) => {
    expect((await completing(fields).at(marked)).map(({ insertText }) => insertText)).toEqual(offered);
  });

  it.each([
    ['the child record enclosing the string, rather than its owner', documentOf(`"Placed": [{ "FormKey": "${CHILD}", "Mode": "|" }]`), CHILD],
    ['the record whose FormKey is spelled as Mutagen reads it, by its canonical FormKey', documentOf('"Mode": "|"', '00080a_Mod.esp'), '00080A:Mod.esp'],
  ])('offers the values of %s', async (_case, marked, record) => {
    const { at, asked } = completing([enumField]);

    expect([(await at(marked)).map(({ insertText }) => insertText), asked()]).toEqual([['Auto', 'Single'], [record]]);
  });

  it.each([
    ['in a property name', documentOf('"Mo|": 1'), SOURCE],
    ['outside a record', '{ "Mode": "|" }', SOURCE],
    ['in a JSON file outside plugin source', documentOf('"Mode": "|"'), '/mods/ModA/settings.json'],
  ])('offers nothing %s', async (_case, marked, path) => {
    expect(await completing([enumField]).at(marked, path)).toEqual([]);
  });

  it('offers nothing for a string field that has no members', async () => {
    expect(await completing([fieldOf({ name: 'Mode', type: 'string' })]).at(documentOf('"Mode": "|"'))).toEqual([]);
  });
});

it('writes why to the Output, and offers nothing, when mEdit cannot answer the record\'s comparison', async () => {
  const { reporter } = sourceLanguageOver({ arrange: (client) => { client.setQueryAnswerOnce('getComparison', Promise.reject(new Error('mEdit is down.'))); } });

  const found = await host.complete(SOURCE, documentOf('"Mode": "|"'));

  expect(found).toEqual([]);
  expect(reporter.shownFailures).toEqual([{ severity: 'error', message: `Completion cannot list what ${OWNER} offers here.`, detail: 'mEdit is down.' }]);
});
