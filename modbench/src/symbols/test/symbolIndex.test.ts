import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';

vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState, SymbolKind, CompletionItemKind,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import * as vscode from 'vscode';
import { symbolIndex } from '../symbolIndex';
import type { Definition, References } from '../symbolKind';
import { copyDocument } from '../../textDocuments/recordDocument';
import { fakeKind, fakeKinds } from './fakeKinds';

const STAND = '000700:A.esp';
const MOD_A = { name: 'A.esp', origin: 'ModA' };
const STAND_FILE = '/source/ModA/plugin-source/A.esp/Stand.json';
const RECORD = { kind: 'record', formKey: STAND } as const;

const IN_SOURCE = new vscode.Location(vscode.Uri.file(STAND_FILE), new vscode.Range(new vscode.Position(0, 2), new vscode.Position(0, 9)));
const PLACE = { file: STAND_FILE, start: { line: 0, character: 2 }, end: { line: 0, character: 9 } };

async function inRendered(): Promise<vscode.Location> {
  const opened = await copyDocument({
    getCopyDocument: () => Promise.resolve({ kind: 'Rendered', location: 'Stand - 000700_A.esp.json' }), getRecordOwner: () => Promise.resolve(MOD_A),
  }, { formKey: STAND, plugin: MOD_A });
  if ('refused' in opened) throw new Error(opened.refused);
  return new vscode.Location(opened.uri, new vscode.Position(0, 0));
}

const recordAnswering = (over: { definition?: Definition; references?: References }) => symbolIndex(fakeKinds({ record: fakeKind({
  definitionOf: () => Promise.resolve(over.definition ?? { none: 'Not asked.' }),
  referencesTo: () => Promise.resolve(over.references ?? { refused: 'Not asked.' }),
}) }));

describe('the agent\'s reading of a record (symbols.md, The symbols, Record)', () => {
  it('reads a definition in plugin source as its place, and one in a plugin with no plugin source as its plugin', async () => {
    expect([
      await recordAnswering({ definition: { at: IN_SOURCE } }).definitionOf(RECORD),
      await recordAnswering({ definition: { at: await inRendered() } }).definitionOf(RECORD),
    ]).toEqual([{ place: PLACE }, { plugin: MOD_A }]);
  });

  it('reads each reference in plugin source as its place, and one in a plugin with no plugin source as the record that holds it', async () => {
    const found = await recordAnswering({ references: { locations: [IN_SOURCE, await inRendered()], unread: ['B.esp: unreadable'] } }).referencesTo(RECORD);

    expect(found).toEqual({ references: [PLACE, { formKey: STAND, plugin: MOD_A }], leftOut: ['B.esp: unreadable'] });
  });

  it('reads a refusal as the refusal, for a definition and for references', async () => {
    const refusing = recordAnswering({ definition: { refused: 'mEdit is down' }, references: { refused: 'mEdit is down' } });

    expect([await refusing.definitionOf(RECORD), await refusing.referencesTo(RECORD)]).toEqual([{ refused: 'mEdit is down' }, { refused: 'mEdit is down' }]);
  });
});

describe('the agent\'s reading of every kind, as each entry point is given it (agent.md, Names, story 4)', () => {
  const ARCHIVE = '/mods/Mod/Mod - Textures.ba2';

  it.each<[string, Definition, unknown]>([
    ['a row, as the view it selects', { row: 'Plugins', show: () => Promise.resolve() }, { row: 'Plugins' }],
    ['a loose copy shown in the Explorer, as its file', { shown: { kind: 'loose', path: '/mods/Base Mod' } }, { file: '/mods/Base Mod' }],
    ['an archived copy, as its archive and its path there', { shown: { kind: 'archived', gameRelease: 'Fallout4', archive: ARCHIVE, file: 'textures/a.dds' } }, { archived: { archive: ARCHIVE, file: 'textures/a.dds' } }],
    ['a file opened, as itself', { file: '/mods/Mod/Scripts/Source/User/Quest.psc' }, { file: '/mods/Mod/Scripts/Source/User/Quest.psc' }],
    ['a kind with no definition, saying so', { none: 'A profile has no definition.' }, { none: 'A profile has no definition.' }],
  ])('reads %s', async (_case, definition, read) => {
    const symbols = symbolIndex(fakeKinds({ entry: fakeKind({ definitionOf: () => Promise.resolve(definition) }) }));

    expect(await symbols.definitionOf({ kind: 'mod', name: 'Base Mod' })).toEqual(read);
  });

  it.each([
    [{ kind: 'plugin', name: 'A.esp' }, 'plugin'],
    [{ kind: 'mod', name: 'ModA' }, 'entry'],
    [{ kind: 'profile', name: 'Default' }, 'entry'],
    [{ kind: 'script', name: 'Ns:Quest' }, 'script'],
    [{ kind: 'file', path: 'textures/a.dds' }, 'file'],
  ] as const)('asks %j of the kind that answers for it', async (symbol, answering) => {
    const asked: unknown[] = [];
    const references = (symbolAsked: never): Promise<References> => { asked.push(symbolAsked); return Promise.resolve({ locations: [], unread: [answering] }); };
    const symbols = symbolIndex(fakeKinds({ [answering]: fakeKind({ referencesTo: references }) }));

    expect(await symbols.referencesTo(symbol)).toEqual({ references: [], leftOut: [answering] });
    expect(asked).toEqual([symbol]);
  });
});
