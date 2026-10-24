import { describe, it, expect, vi } from 'vitest';
import { uriFrom, uriWith } from '../../test/vscodeMock';

vi.mock('vscode', () => ({
  Uri: { from: uriFrom, file: (path: string) => uriWith('file', path) },
}));

import { locateRecord } from '../recordLocation';
import { formKeyValue } from '../sourceText';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const GUN_FILE = '/source/ModA/plugin-source/A.esp/Weapons/Gun.json';
const GUN_TEXT = `{\n  "FormKey": "${GUN}",\n  "Base": "${GUN}",\n  "EditorID": "Gun"\n}`;

function located(text = GUN_TEXT) {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getRecordOwner', modA);
  client.setQueryAnswer('getCopyDocument', { kind: 'OwnFile', location: GUN_FILE });
  const at = (record: { formKey: string }) =>
    locateRecord({ client, open: () => Promise.resolve({ getText: () => text }) }, record, formKeyValue);
  return { at };
}

describe('a record\'s place in its document, where Referenced By anchors its list', () => {
  it('is its own FormKey value in its document, not a field that references it', async () => {
    expect(await located().at({ formKey: GUN })).toMatchObject({ uri: { path: GUN_FILE }, start: 15, end: 29 });
  });

  it('is refused, saying why, where the document states no FormKey member for it', async () => {
    const { at } = located('{ "EditorID": "Gun" }');

    expect(await at({ formKey: GUN })).toEqual({ refused: `${GUN_FILE} states no ${GUN} member.` });
  });
});