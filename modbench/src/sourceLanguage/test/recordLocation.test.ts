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

import { locateRecord } from '../recordLocation';
import { formKeyValue } from '../sourceText';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const GUN_FILE = '/mods/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "Base": "${GUN}",\n  "EditorID": "Gun"\n}`;

function located(text = GUN_TEXT) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
  const at = (record: { formKey: string; plugin?: typeof modA }) =>
    locateRecord({ client, open: () => Promise.resolve({ getText: () => text }) }, record, formKeyValue);
  return { client, at };
}

describe('a record\'s place in its document, where Referenced By anchors its list', () => {
  it('is its own FormKey value in its winning copy\'s document', async () => {
    const { client, at } = located();

    const found = await at({ formKey: GUN });

    expect(found && 'start' in found ? GUN_TEXT.slice(found.start, found.end) : found).toBe(`"${GUN}"`);
    expect(found && 'start' in found ? found.start : found).toBe(GUN_TEXT.indexOf(`"${GUN}"`));
    expect(client.calls).toContainEqual({ method: 'getCopyDocument', args: [modA, GUN] });
  });

  it('is in the document of the copy the record names', async () => {
    const { client, at } = located();

    await at({ formKey: GUN, plugin: modB });

    expect(client.calls.map(({ method }) => method)).not.toContain('getRecordOwner');
    expect(client.calls).toContainEqual({ method: 'getCopyDocument', args: [modB, GUN] });
  });

  it('is refused, saying why, where the document states no FormKey member for it', async () => {
    const { at } = located('{ "EditorID": "Gun" }');

    expect(await at({ formKey: GUN })).toEqual({ refused: `${GUN_FILE} states no ${GUN} member.` });
  });

  it('is nowhere for a record no active plugin holds', async () => {
    const { client, at } = located();
    client.setQueryAnswer('getRecordOwner', undefined);

    expect(await at({ formKey: GUN })).toBeUndefined();
  });
});
