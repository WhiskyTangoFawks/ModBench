import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import type * as vscode from 'vscode';
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

const OWN_FILE = `{ "FormKey": "${STAND}", "Model": "${GUN}", "Keywords": ["${GUN}"] }`;
const CELL = `{ "FormKey": "000701:A.esp", "Persistent": [{ "FormKey": "${PERSISTENT}", "Base": "${GUN}" }] }`;
const RENDERED = `{\n  "FormKey": "${STAND}",\n  "Model": "${GUN}"\n}`;

const quoted = `"${GUN}"`;
const spansOf = (text: string) => [...text.matchAll(new RegExp(quoted, 'g'))].map(({ index }) => ({ start: index, end: index + quoted.length }));

const PLACED: PlacedReferences = {
  copies: [
    { formKey: STAND, plugin: modA, document: { kind: 'OwnFile', location: STAND_FILE }, spans: spansOf(OWN_FILE) },
    { formKey: PERSISTENT, plugin: modA, document: { kind: 'ContainersFile', location: CELL_FILE }, spans: spansOf(CELL) },
    { formKey: STAND, plugin: modB, document: { kind: 'Rendered', location: STAND_RENDERED }, spans: spansOf(RENDERED) },
  ],
  leftOut: [],
};

const TEXTS = new Map([[STAND_FILE, OWN_FILE], [CELL_FILE, CELL], [`/ModB/B.esp/${STAND_RENDERED}`, RENDERED]]);

function references(answer: PlacedReferences | ReadFailed = PLACED, texts = TEXTS) {
  const asked = vi.fn((_formKey: string) => Promise.resolve(answer));
  const read = referencesToFormKey({
    client: { getPlacedReferences: asked },
    open: (uri: vscode.Uri) => {
      const text = texts.get(uri.path);
      return text === undefined ? Promise.reject(new Error('The file is gone.')) : Promise.resolve({ getText: () => text });
    },
  });
  return { asked, read };
}

const listed = ({ found }: Awaited<ReturnType<ReturnType<typeof references>['read']>>) =>
  found.map(({ uri, document, start, end }) => [`${uri.scheme}:${uri.path}`, document.getText().slice(start, end), start]);

describe('Find All References on a FormKey (symbols.md, The features, story 2)', () => {
  it('asks mEdit once, for the record, whatever the number of referrers', async () => {
    const { asked, read } = references();

    await read(GUN);

    expect(asked.mock.calls).toEqual([[GUN]]);
  });

  it('lists each place each copy names the record, at the copy\'s document', async () => {
    const [own, keyword] = spansOf(OWN_FILE);

    expect(listed(await references().read(GUN))).toEqual([
      [`file:${STAND_FILE}`, quoted, own?.start],
      [`file:${STAND_FILE}`, quoted, keyword?.start],
      [`modbench-child-record:${CELL_FILE}`, quoted, CELL.indexOf(quoted)],
      [`modbench-rendered:/ModB/B.esp/${STAND_RENDERED}`, quoted, RENDERED.indexOf(quoted)],
    ]);
  });

  it('reports each copy mEdit left out, and each whose document fails to open, saying why', async () => {
    const found = await references(
      { ...PLACED, leftOut: [`${STAND} in C.esp (ModC): its file names ${GUN} nowhere.`] }, new Map([[STAND_FILE, OWN_FILE], [CELL_FILE, CELL]]),
    ).read(GUN);

    expect(found.leftOut).toEqual([`${STAND} in C.esp (ModC): its file names ${GUN} nowhere.`, `${STAND} in B.esp (ModB): The file is gone.`]);
  });

  it('throws mEdit\'s refusal when it cannot answer over the whole plugin set', async () => {
    const { read } = references({ failed: 'refused', refusal: 'The record index is still reading.' });

    await expect(read(GUN)).rejects.toThrow('The record index is still reading.');
  });
});
