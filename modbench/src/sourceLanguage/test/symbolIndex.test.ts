import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import * as vscode from 'vscode';
import { symbolIndex, type SymbolIndex } from '../symbolIndex';
import { copyDocumentsOf, copyKey } from './copyDocuments';
import type { ReferenceResult } from '../../client';

const STAND = '000700:A.esp';
const GUN = '000900:A.esp';
const MOD_A = { name: 'A.esp', origin: 'ModA' };
const STAND_FILE = '/source/ModA/plugin-source/A.esp/Stand.json';
const STAND_TEXT = `{ "FormKey": "${STAND}", "Model": "${GUN}" }`;
const RENDERED = 'Stand - 000700_A.esp.json';

const stubs = {
  plugin: { definitionOf: () => ({ file: '/plugin' }), placesNaming: () => Promise.resolve({ references: [], leftOut: ['plugin'] }) },
  entry: { definitionOf: () => ({ file: '/entry' }), placesNaming: () => Promise.resolve({ references: [], leftOut: ['entry'] }) },
  script: { definitionOf: () => ({ file: '/script' }), placesNaming: () => Promise.resolve({ references: [], leftOut: ['script'] }) },
  file: { definitionOf: () => ({ file: '/file' }), placesNaming: () => Promise.resolve({ references: [], leftOut: ['file'] }) },
};

function index(copies: Parameters<typeof copyDocumentsOf>[0], options: { owner?: typeof MOD_A; rows?: ReferenceResult[]; mEditDown?: boolean } = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(copies);
  const { owner = MOD_A, rows = [], mEditDown = false } = options;
  const down = () => Promise.reject(new Error('mEdit is down'));
  return symbolIndex({
    ...stubs,
    client: {
      getRecordOwner: () => (mEditDown ? down() : Promise.resolve(copies[copyKey(STAND, owner)] ? owner : undefined)),
      getCopyDocument,
      getReferencesInActiveOrCompiledPlugins: () => (mEditDown ? down() : Promise.resolve(rows)),
    },
    open: (uri) => {
      const text = uri.scheme === 'file' ? textOnFile(uri.path) : STAND_TEXT;
      return Promise.resolve({ getText: () => text ?? '', positionAt: (offset: number) => new vscode.Position(0, offset) });
    },
  });
}

describe('the symbol index on a record (symbols.md, The symbols, Record)', () => {
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

describe('the symbol index on every other kind', () => {
  it.each([
    [{ kind: 'plugin', name: 'A.esp' }, '/plugin', 'plugin'],
    [{ kind: 'mod', name: 'ModA' }, '/entry', 'entry'],
    [{ kind: 'profile', name: 'Default' }, '/entry', 'entry'],
    [{ kind: 'script', name: 'Ns:Quest' }, '/script', 'script'],
    [{ kind: 'file', path: 'textures/a.dds' }, '/file', 'file'],
  ] as const)('answers %j from the language that owns it', async (symbol, file, left) => {
    const answering = index({});

    expect(await answering.definitionOf(symbol)).toEqual({ file });
    expect(await answering.referencesTo(symbol)).toEqual({ references: [], leftOut: [left] });
  });
});
