import { describe, it, expect, vi } from 'vitest';
import { Range, Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri, Range, Location: class { constructor(readonly uri: unknown, readonly range: unknown) {} } }));

import { referencesToFormKey } from '../formKeyReferences';
import type { PlacedReferences } from '../../client/MEditClient';
import type { ReadFailed } from '../../wire/readFailed';

const GUN = '000900:A.esp';
const STAND = '000700:A.esp';
const PERSISTENT = '000703:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const STAND_FILE = '/source/ModA/plugin-source/A.esp/Stand.json';
const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cell.json';
const STAND_RENDERED = 'Stand - 000700_A.esp.json';

const on = (line: number, character: number) => ({ start: { line, character }, end: { line, character: character + 16 } });
const LEFT_OUT = `${STAND} in C.esp (ModC): its file names ${GUN} nowhere.`;

const PLACED: PlacedReferences = {
  copies: [
    { formKey: STAND, plugin: modA, document: { kind: 'OwnFile', location: STAND_FILE }, ranges: [on(2, 11), on(3, 15)] },
    { formKey: PERSISTENT, plugin: modA, document: { kind: 'ContainersFile', location: CELL_FILE }, ranges: [on(7, 14)] },
    { formKey: STAND, plugin: modB, document: { kind: 'Rendered', location: STAND_RENDERED }, ranges: [on(2, 11)] },
  ],
  leftOut: [LEFT_OUT],
};

function references(answer: PlacedReferences | ReadFailed = PLACED) {
  const asked = vi.fn((_formKey: string) => Promise.resolve(answer));
  return { asked, read: referencesToFormKey({ getPlacedReferences: asked }) };
}

describe('Find All References on a FormKey (symbols.md, The features, story 2)', () => {
  it('asks mEdit once, for the record, whatever the number of referrers', async () => {
    const { asked, read } = references();

    await read(GUN);

    expect(asked.mock.calls).toEqual([[GUN]]);
  });

  it('lists each place each copy names the record, at the copy\'s document', async () => {
    const { locations } = await references().read(GUN);

    expect(locations.map(({ uri, range }) => [`${uri.scheme}:${uri.path}`, range.start, range.end])).toEqual([
      [`file:${STAND_FILE}`, { line: 2, character: 11 }, { line: 2, character: 27 }],
      [`file:${STAND_FILE}`, { line: 3, character: 15 }, { line: 3, character: 31 }],
      [`modbench-child-record:${CELL_FILE}`, { line: 7, character: 14 }, { line: 7, character: 30 }],
      [`modbench-rendered:/ModB/B.esp/${STAND_RENDERED}`, { line: 2, character: 11 }, { line: 2, character: 27 }],
    ]);
  });

  it('reports each copy mEdit left out, saying why', async () => {
    expect((await references().read(GUN)).leftOut).toEqual([LEFT_OUT]);
  });

  it('throws mEdit\'s refusal when it cannot answer over the whole plugin set', async () => {
    const { read } = references({ failed: 'refused', refusal: 'The record index is still reading.' });

    await expect(read(GUN)).rejects.toThrow('The record index is still reading.');
  });
});
