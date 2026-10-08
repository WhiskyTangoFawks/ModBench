import { describe, it, expect, vi } from 'vitest';
import { uriFrom } from '../../test/vscodeMock';

interface TestUri { scheme: string; path: string; query: string; with(change: Partial<Pick<TestUri, 'scheme' | 'query'>>): TestUri }

const h = vi.hoisted(() => {
  const uri = (scheme: string, path: string, query = ''): TestUri =>
    ({ scheme, path, query, with: (change) => uri(change.scheme ?? scheme, path, change.query ?? query) });
  return { uri };
});

vi.mock('vscode', () => ({
  Uri: { from: uriFrom, file: (path: string) => h.uri('file', path) },
}));

import type * as vscode from 'vscode';
import { definitionsOf } from '../formKeyDefinition';
import { formKeyMember } from '../sourceText';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { recordingReporter } from '../../test/surfacingDoubles';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;
const REFERENCING = `{ "FormKey": "000700:A.esp", "Armor": "${GUN}" }`;
const AT_GUN = REFERENCING.indexOf(GUN) + 1;

const spanned = (text: string, formKey: string): string | undefined => {
  const member = formKeyMember(text, formKey);
  return member && text.slice(member.start, member.end);
};

describe('a definition\'s place in its record\'s document (plugin-source.md, In the text editor, story 1)', () => {
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

function definitions({ open = (): Promise<{ getText(): string }> => Promise.resolve({ getText: () => GUN_TEXT }) } = {}) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { path: GUN_FILE, isContainersDocument: false });
  const reporter = recordingReporter();
  const opened: unknown[] = [];
  const definitionAt = definitionsOf({
    client, reporter, open: (uri: vscode.Uri) => { opened.push(uri); return open(); },
  });
  return { client, reporter, opened, definitionAt };
}

describe('Go to Definition on a FormKey (plugin-source.md, In the text editor, story 1)', () => {
  it('opens the winning copy\'s file at the record\'s own FormKey member', async () => {
    const { definitionAt } = definitions();

    const found = await definitionAt(REFERENCING, AT_GUN);

    expect(found?.document.getText().slice(found.start, found.end)).toBe(`"FormKey": "${GUN}"`);
    expect(found?.uri).toMatchObject({ scheme: 'file', path: GUN_FILE });
  });

  it('offers none, and writes why to the Output, where the record\'s document states no FormKey member for it', async () => {
    const { reporter, definitionAt } = definitions({ open: () => Promise.resolve({ getText: () => '{ "EditorID": "Gun" }' }) });

    expect(await definitionAt(REFERENCING, AT_GUN)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: `Go to Definition cannot open ${GUN}.`, detail: `${GUN_FILE} states no ${GUN} member.` },
    ]);
  });

  it('offers none for a FormKey no active plugin holds, and writes nothing', async () => {
    const { client, reporter, definitionAt } = definitions();
    client.setQueryAnswer('getRecordOwner', undefined);

    expect(await definitionAt(REFERENCING, AT_GUN)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([]);
  });

  it('offers none, and writes why to the Output, when the winning plugin holds no copy', async () => {
    const { client, reporter, definitionAt } = definitions();
    client.setQueryAnswer('getCopyDocument', null);

    expect(await definitionAt(REFERENCING, AT_GUN)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([
      { severity: 'warning', message: `Go to Definition cannot open ${GUN}.`, detail: `A.esp (ModA) holds no ${GUN}.` },
    ]);
  });

  it('offers none, and writes why to the Output, when the record\'s document fails to open', async () => {
    const { reporter, definitionAt } = definitions({ open: () => Promise.reject(new Error('The file is gone.')) });

    expect(await definitionAt(REFERENCING, AT_GUN)).toBeUndefined();
    expect(reporter.shownFailures).toEqual([
      { severity: 'error', message: `Go to Definition cannot open ${GUN}.`, detail: 'The file is gone.' },
    ]);
  });

  it('writes the reason again each time it recurs', async () => {
    const { client, reporter, definitionAt } = definitions();
    client.setQueryAnswer('getCopyDocument', null);

    await definitionAt(REFERENCING, AT_GUN);
    await definitionAt(REFERENCING, AT_GUN);

    expect(reporter.shownFailures).toHaveLength(2);
  });

  it('asks nothing for a string that is not a FormKey', async () => {
    const { client, definitionAt } = definitions();
    const text = '{ "Name": "Rusty Gun" }';

    expect(await definitionAt(text, text.indexOf('Rusty'))).toBeUndefined();
    expect(client.calls).toEqual([]);
  });
});
