import { describe, it, expect, vi } from 'vitest';
import { Range, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, Range, Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} } }));

import { referencesToFormKey } from '../formKeyReferences';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { cancellableToken } from '../../client/test/fixtures';
import { copyDocumentUri } from '../../textDocuments/recordDocument';
import type { PlacedReferences } from '../../client/MEditClient';

const GUN = '000900:A.esp';
const STAND = '000700:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };

const on = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 16 } });

const OWN_FILE = { kind: 'OwnFile', location: '/source/ModA/plugin-source/A.esp/Stand.json' } as const;
const RENDERED = { kind: 'Rendered', location: 'Stand - 000700_A.esp.json' } as const;
const PLACED: PlacedReferences = {
  copies: [
    { formKey: STAND, plugin: modA, document: OWN_FILE, ranges: [on(2, 11), on(3, 15)] },
    { formKey: STAND, plugin: modB, document: RENDERED, ranges: [on(2, 11)] },
  ],
  leftOut: [],
};

function references() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPlacedReferences', PLACED);
  return { client, read: referencesToFormKey(client) };
}

describe('Find All References on a FormKey (symbols.md, The features, story 2)', () => {
  it('asks mEdit with the token of the request it answers', async () => {
    const { client, read } = references();
    const { token } = cancellableToken();

    await read(GUN, token);

    expect(client.calls).toEqual([{ method: 'getPlacedReferences', args: [GUN, token] }]);
  });

  it('asks mEdit once, for the record, whatever the number of referrers, and nothing else', async () => {
    const { client, read } = references();

    await read(GUN);

    expect(client.calls).toEqual([{ method: 'getPlacedReferences', args: [GUN, undefined] }]);
  });

  it('lists each place each copy names the record, at the copy\'s document', async () => {
    const { locations } = await references().read(GUN);

    expect(locations.map(({ uri, range }) => [uri, range.start, range.end])).toEqual([
      [copyDocumentUri({ formKey: STAND, plugin: modA }, OWN_FILE), { line: 2, character: 11 }, { line: 2, character: 27 }],
      [copyDocumentUri({ formKey: STAND, plugin: modA }, OWN_FILE), { line: 3, character: 15 }, { line: 3, character: 31 }],
      [copyDocumentUri({ formKey: STAND, plugin: modB }, RENDERED), { line: 2, character: 11 }, { line: 2, character: 27 }],
    ]);
  });
});
