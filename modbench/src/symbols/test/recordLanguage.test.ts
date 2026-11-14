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
import { formKeyMember } from '../formKeyText';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';
import { localFailure } from '../../wire/readFailed';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;
const REFERENCING = `{ "FormKey": "000700:A.esp", "Armor": "${GUN}" }`;
const RECORD = { kind: 'record', formKey: GUN } as const;

const spanned = (text: string, formKey: string): string | undefined => {
  const member = formKeyMember(text, formKey);
  return member && text.slice(member.start, member.end);
};

describe('a definition\'s place in its record\'s document (symbols.md, The symbols, Record)', () => {
  it('is the record\'s own FormKey member', () => {
    expect(spanned(GUN_TEXT, GUN)).toBe(`"FormKey": "${GUN}"`);
  });

  it('is a child record\'s FormKey member in its own object, in its owner\'s file', () => {
    const text = `{ "FormKey": "000700:A.esp", "Temporary": [{ "FormKey": "000802:A.esp" }, { "FormKey": "${GUN}", "EditorID": "Ref" }] }`;

    expect(formKeyMember(text, GUN)?.start).toBe(text.indexOf(`"FormKey": "${GUN}"`));
  });

  it('passes over a field that references the record', () => {
    const text = `{ "FormKey": "000700:A.esp", "Base": "${GUN}", "Temporary": [{ "FormKey": "${GUN}" }] }`;

    expect(formKeyMember(text, GUN)?.start).toBe(text.indexOf(`"FormKey": "${GUN}"`));
  });

  it('is nowhere in a document that states no such member', () => {
    expect(formKeyMember(`{ "Base": "${GUN}" }`, GUN)).toBeUndefined();
  });
});

function kind({ open = (): Promise<{ getText(): string }> => Promise.resolve({ getText: () => GUN_TEXT }) } = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
  const opened: unknown[] = [];
  const record = recordLanguage({
    client, reporter: recordingReporter(),
    open: async (uri: vscode.Uri) => { opened.push(uri); return { ...await open(), positionAt: (offset: number) => new vscode.Position(0, offset) }; },
  });
  return { client, opened, record };
}

describe('a record\'s FormKey in plugin source (symbols.md, The symbols, Record)', () => {
  const document = (text: string, path = GUN_FILE) => ({ uri: Uri.file(path), getText: () => text });

  it('names the record, spanning the FormKey string, quotes included', async () => {
    const found = await kind().record.nameAt(document(REFERENCING), REFERENCING.indexOf(GUN));

    expect([found?.symbol, REFERENCING.slice(found?.start, found?.end)]).toEqual([RECORD, `"${GUN}"`]);
  });

  it.each([
    ['a string that is not a FormKey', '{ "Name": "Rusty Gun" }', 'Rusty', GUN_FILE],
    ['a FormKey spelled as a property name', `{ "${GUN}": 1 }`, '000801', GUN_FILE],
    ['a place outside a string', `{ "A": "${GUN}" }`, '{', GUN_FILE],
    ['a FormKey in a file that is no plugin source', REFERENCING, '000801', '/instance/notes.json'],
  ])('names nothing at %s, asking mEdit nothing', async (_case, text, at, path) => {
    const { record, client } = kind();

    expect(await record.nameAt(document(text, path), text.indexOf(at))).toBeUndefined();
    expect(client.calls).toEqual([]);
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
