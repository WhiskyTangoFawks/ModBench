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
import { symbolIndex, type SymbolIndex } from '../symbolIndex';
import { recordLanguage } from '../recordLanguage';
import type { Definition, References } from '../symbolKind';
import { copyDocumentsOf, copyKey } from './copyDocuments';
import { fakeKind, fakeKinds } from './fakeKinds';
import { recordingReporter } from '../../test/surfacingDoubles';
import type { ReferenceResult } from '../../client';

const STAND = '000700:A.esp';
const GUN = '000900:A.esp';
const MOD_A = { name: 'A.esp', origin: 'ModA' };
const STAND_FILE = '/source/ModA/plugin-source/A.esp/Stand.json';
const STAND_TEXT = `{ "FormKey": "${STAND}", "Model": "${GUN}" }`;
const RENDERED = 'Stand - 000700_A.esp.json';

function index(copies: Parameters<typeof copyDocumentsOf>[0], options: { owner?: typeof MOD_A; rows?: ReferenceResult[]; mEditDown?: boolean } = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(copies);
  const { owner = MOD_A, rows = [], mEditDown = false } = options;
  const down = () => Promise.reject(new Error('mEdit is down'));
  const record = recordLanguage({
    client: {
      getRecordOwner: () => (mEditDown ? down() : Promise.resolve(copies[copyKey(STAND, owner)] ? owner : undefined)),
      getCopyDocument,
      getReferencesInActiveOrCompiledPlugins: () => (mEditDown ? down() : Promise.resolve(rows)),
      getComparison: down, searchRecords: down, getPlugins: down,
    },
    reporter: recordingReporter(),
    open: (uri) => {
      const text = uri.scheme === 'file' ? textOnFile(uri.path) : STAND_TEXT;
      return Promise.resolve({ getText: () => text ?? '', positionAt: (offset: number) => new vscode.Position(0, offset) });
    },
  });
  return symbolIndex(fakeKinds({ record }));
}

describe('the agent\'s reading of a record (symbols.md, The symbols, Record)', () => {
  const inSource = { [copyKey(STAND, MOD_A)]: { file: STAND_FILE, text: STAND_TEXT } };
  const rendered = { [copyKey(STAND, MOD_A)]: { rendered: RENDERED, text: STAND_TEXT } };
  const spanOf = (text: string) => ({ file: STAND_FILE, start: { line: 0, character: STAND_TEXT.indexOf(text) }, end: { line: 0, character: STAND_TEXT.indexOf(text) + text.length } });
  const row: ReferenceResult = { formKey: STAND, plugin: 'A.esp', origin: 'ModA', fieldPath: 'Model', recordType: 'STAT', recordTypeName: 'Static' };

  it.each([
    ['at its member in plugin source', inSource, { place: spanOf(`"FormKey": "${STAND}"`) }],
    ['in a plugin with no plugin source by its plugin', rendered, { plugin: MOD_A }],
    ['nowhere when no active plugin holds it, refusing', {}, { refused: `No active plugin holds ${STAND}.` }],
  ])('defines a record %s', async (_where, copies, expected) => {
    expect(await index(copies).definitionOf({ kind: 'record', formKey: STAND })).toEqual(expected);
  });

  it.each([
    ['at its reference in plugin source', inSource, [spanOf(`"${GUN}"`)]],
    ['at the record that holds it, in a plugin with no plugin source', rendered, [{ formKey: STAND, plugin: MOD_A }]],
  ])('lists each copy that references a record %s', async (_where, copies, references) => {
    expect(await index(copies, { rows: [row] }).referencesTo({ kind: 'record', formKey: GUN })).toEqual({ references, leftOut: [] });
  });

  it.each([
    ['where it is defined', (symbols: SymbolIndex) => symbols.definitionOf({ kind: 'record', formKey: GUN }), `Where ${GUN} is defined could not be read: mEdit is down`],
    ['what references it', (symbols: SymbolIndex) => symbols.referencesTo({ kind: 'record', formKey: GUN }), `mEdit cannot list what references ${GUN}: mEdit is down`],
  ])('refuses, rather than answer nothing, when mEdit cannot say %s', async (_read, read, refused) => {
    expect(await read(index({}, { mEditDown: true }))).toEqual({ refused });
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
