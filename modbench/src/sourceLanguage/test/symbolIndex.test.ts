import { describe, expect, it, vi } from 'vitest';
import { TreeItem, TreeItemCollapsibleState, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  Uri, TreeItem, TreeItemCollapsibleState,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import * as vscode from 'vscode';
import { symbolIndex } from '../symbolIndex';
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

function index(copies: Parameters<typeof copyDocumentsOf>[0], options: { owner?: typeof MOD_A; rows?: ReferenceResult[]; referencesFail?: boolean } = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(copies);
  const { owner = MOD_A, rows = [], referencesFail = false } = options;
  return symbolIndex({
    ...stubs,
    client: {
      getRecordOwner: () => Promise.resolve(copies[copyKey(STAND, owner)] ? owner : undefined),
      getCopyDocument,
      getReferencesInActiveOrCompiledPlugins: () => (referencesFail ? Promise.reject(new Error('mEdit is down')) : Promise.resolve(rows)),
    },
    open: (uri) => {
      const text = uri.scheme === 'file' ? textOnFile(uri.path) : STAND_TEXT;
      return Promise.resolve({ getText: () => text ?? '', positionAt: (offset: number) => new vscode.Position(0, offset) });
    },
  });
}

describe('the symbol index on a record (symbols.md, The symbols, Record)', () => {
  it('defines a record at its member in plugin source', async () => {
    const found = await index({ [copyKey(STAND, MOD_A)]: { file: STAND_FILE, text: STAND_TEXT } }).definitionOf({ kind: 'record', formKey: STAND });

    const member = `"FormKey": "${STAND}"`;
    expect(found).toEqual({ place: { file: STAND_FILE, start: { line: 0, character: STAND_TEXT.indexOf(member) }, end: { line: 0, character: STAND_TEXT.indexOf(member) + member.length } } });
  });

  it('defines a record in a plugin with no plugin source by its plugin', async () => {
    const found = await index({ [copyKey(STAND, MOD_A)]: { rendered: RENDERED, text: STAND_TEXT } }).definitionOf({ kind: 'record', formKey: STAND });

    expect(found).toEqual({ plugin: MOD_A });
  });

  it('refuses a record no active plugin holds', async () => {
    expect(await index({}).definitionOf({ kind: 'record', formKey: STAND })).toEqual({ refused: `No active plugin holds ${STAND}.` });
  });

  it('lists each copy that references it, at its reference', async () => {
    const row: ReferenceResult = { formKey: STAND, plugin: 'A.esp', origin: 'ModA', fieldPath: 'Model', recordType: 'STAT', recordTypeName: 'Static' };
    const found = await index({ [copyKey(STAND, MOD_A)]: { file: STAND_FILE, text: STAND_TEXT } }, { rows: [row] }).referencesTo({ kind: 'record', formKey: GUN });

    expect(found).toEqual({
      references: [{ file: STAND_FILE, start: { line: 0, character: STAND_TEXT.indexOf(`"${GUN}"`) }, end: { line: 0, character: STAND_TEXT.indexOf(`"${GUN}"`) + GUN.length + 2 } }],
      leftOut: [],
    });
  });

  it('lists a reference in a plugin with no plugin source at the record that holds it, which has no file', async () => {
    const row: ReferenceResult = { formKey: STAND, plugin: 'A.esp', origin: 'ModA', fieldPath: 'Model', recordType: 'STAT', recordTypeName: 'Static' };
    const found = await index({ [copyKey(STAND, MOD_A)]: { rendered: RENDERED, text: STAND_TEXT } }, { rows: [row] }).referencesTo({ kind: 'record', formKey: GUN });

    expect(found).toEqual({ references: [{ formKey: STAND, plugin: MOD_A }], leftOut: [] });
  });

  it('refuses, rather than list nothing, when mEdit cannot say what references it', async () => {
    expect(await index({}, { referencesFail: true }).referencesTo({ kind: 'record', formKey: GUN }))
      .toEqual({ refused: `mEdit cannot list what references ${GUN}: mEdit is down` });
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
