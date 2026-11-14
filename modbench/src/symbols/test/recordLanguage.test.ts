import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';
import { CompletionItemKind, SymbolKind } from './iconsMock';

vi.mock('vscode', () => ({
  Uri, SymbolKind, CompletionItemKind,
  Position: class { constructor(readonly line: number, readonly character: number) {} },
  Range: class { constructor(readonly start: unknown, readonly end: unknown) {} },
  Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} },
}));

import * as vscode from 'vscode';
import { recordLanguage } from '../recordLanguage';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { localFailure } from '../../wire/readFailed';
import { sourceNames } from './fakeSourceNames';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;
const REFERENCING = `{ "FormKey": "000700:A.esp", "Armor": "${GUN}" }`;
const NAMED = { start: REFERENCING.indexOf(GUN) - 1, end: REFERENCING.indexOf(GUN) + GUN.length + 1 };
const RECORD = { kind: 'record', formKey: GUN } as const;

function kind({ open = (): Promise<{ getText(): string }> => Promise.resolve({ getText: () => GUN_TEXT }) } = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
  const opened: unknown[] = [];
  const record = recordLanguage({
    client, reporter: recordingReporter(), names: sourceNames({ recordAt: () => ({ ...NAMED, formKey: GUN }) }),
    open: async (uri: vscode.Uri) => { opened.push(uri); return { ...await open(), positionAt: (offset: number) => new vscode.Position(0, offset) }; },
  });
  return { client, opened, record };
}

describe('a record\'s FormKey in plugin source (symbols.md, The symbols, Record)', () => {
  it('names the record plugin source names there, at its span', async () => {
    const found = await kind().record.nameAt({ uri: Uri.file(GUN_FILE), getText: () => REFERENCING }, REFERENCING.indexOf(GUN));

    expect(found).toEqual({ ...NAMED, name: GUN, symbol: RECORD });
  });
});

describe('where a record is defined (symbols.md, The symbols, Record)', () => {
  it('is the winning copy\'s file at the record\'s own FormKey member', async () => {
    const member = GUN_TEXT.indexOf(`"FormKey": "${GUN}"`);

    expect(await kind().record.definitionOf(RECORD)).toMatchObject({
      at: { uri: { scheme: 'file', path: GUN_FILE }, range: { start: { character: member }, end: { character: member + `"FormKey": "${GUN}"`.length } } },
    });
  });

  it.each([
    ['the record\'s document states no FormKey member for it', () => kind({ open: () => Promise.resolve({ getText: () => '{ "EditorID": "Gun" }' }) }), `${GUN_FILE} states no ${GUN} member.`],
    ['no active plugin holds it', (k: ReturnType<typeof kind>) => { k.client.setQueryAnswer('getRecordOwner', undefined); return k; }, `No active plugin holds ${GUN}.`],
    ['the winning plugin holds no copy', (k: ReturnType<typeof kind>) => { k.client.setQueryAnswer('getCopyDocument', null); return k; }, `A.esp (ModA) holds no ${GUN}.`],
    ['its document fails to open', () => kind({ open: () => Promise.reject(new Error('The file is gone.')) }), `Where ${GUN} is defined could not be read: The file is gone.`],
  ])('refuses, saying why, where %s', async (_case, arrange, refused) => {
    expect(await arrange(kind()).record.definitionOf(RECORD)).toEqual({ refused });
  });
});

describe('what references a record, and its hover (symbols.md, The symbols, Record)', () => {
  it('refuses, rather than list nothing, when mEdit cannot say what references it', async () => {
    const { client, record } = kind();
    client.setQueryFailure('getReferencesInActiveOrCompiledPlugins', localFailure('mEdit is down'));

    expect(await record.referencesTo(RECORD)).toEqual({ refused: `mEdit cannot list what references ${GUN}: mEdit is down` });
  });

  it('has no tooltip for a FormKey no active plugin holds, so its hover is its name', async () => {
    const { client, record } = kind();
    client.setQueryAnswer('getComparison', null);

    expect(await record.tooltipOf(RECORD)).toEqual([]);
  });
});
