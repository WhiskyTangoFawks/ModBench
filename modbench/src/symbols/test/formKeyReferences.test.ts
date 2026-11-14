import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import type * as vscode from 'vscode';
import { referencesToFormKey } from '../formKeyReferences';
import type { ReferenceResult } from '../../client';
import { copyDocumentsOf, copyKey as key, type CopyOnDisk } from './copyDocuments';

const GUN = '000900:A.esp';
const STAND = '000700:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const modB = { name: 'B.esp', origin: 'ModB' };
const STAND_FILE = '/source/ModA/plugin-source/A.esp/Stand.json';
const STAND_RENDERED = 'Stand - 000700_A.esp.json';

const row = (formKey: string, plugin: typeof modA, fieldPath: string): ReferenceResult =>
  ({ formKey, plugin: plugin.name, origin: plugin.origin, fieldPath, recordType: 'STAT', recordTypeName: 'Static' });

type ReferencesClient = Parameters<typeof referencesToFormKey<{ getText(): string }>>[0]['client'];

function references(rows: ReferenceResult[], copies: Record<string, CopyOnDisk>, answering: Partial<ReferencesClient> = {}) {
  const { getCopyDocument, textOnFile } = copyDocumentsOf(copies);
  const client: ReferencesClient = {
    getReferencesInActiveOrCompiledPlugins: () => Promise.resolve(rows),
    getRecordOwner: () => Promise.reject(new Error('A referrer\'s copy names its plugin.')),
    getCopyDocument,
    ...answering,
  };
  const textAt = (uri: vscode.Uri): string => {
    const query = new URLSearchParams(uri.query);
    const found = uri.scheme === 'modbench-rendered'
      ? copies[key(query.get('formKey') ?? '', { name: query.get('name') ?? '', origin: query.get('origin') ?? '' })]?.text
      : textOnFile(uri.path);
    if (found === undefined) throw new Error('The file is gone.');
    return found;
  };
  const read = referencesToFormKey({
    client, open: (uri) => new Promise<{ getText(): string }>((resolve) => { const text = textAt(uri); resolve({ getText: () => text }); }),
    spanIn: (text, referrer, formKey) => {
      const start = text.indexOf(`"${formKey}"`, text.indexOf(`"FormKey": "${referrer}"`));
      return Promise.resolve({ start, end: start + formKey.length + 2 });
    },
  });
  return { read, referencesAt: async (formKey: string) => (await read(formKey)).found };
}

const listed = (found: Awaited<ReturnType<ReturnType<typeof references>['referencesAt']>>) =>
  found.map(({ uri, document, start, end }) => ({ uri: `${uri.scheme}:${uri.path}`, text: document.getText().slice(start, end), start }));

describe('Find All References on a FormKey (symbols.md, The features, story 2)', () => {
  it('lists one entry for each plugin\'s copy of a referrer, however many of its fields hold the reference', async () => {
    const compiledPlugin = `{ "FormKey": "${STAND}", "Model": "${GUN}", "Keywords": ["${GUN}"] }`;
    const rendered = `{\n  "FormKey": "${STAND}",\n  "Model": "${GUN}"\n}`;
    const { referencesAt } = references(
      [row(STAND, modA, 'Model'), row(STAND, modA, 'Keywords[0]'), row(STAND, modB, 'Model')],
      { [key(STAND, modA)]: { file: STAND_FILE, text: compiledPlugin }, [key(STAND, modB)]: { rendered: STAND_RENDERED, text: rendered } },
    );

    expect(listed(await referencesAt(GUN))).toEqual([
      { uri: `file:${STAND_FILE}`, text: `"${GUN}"`, start: compiledPlugin.indexOf(GUN) - 1 },
      { uri: `modbench-rendered:/ModB/B.esp/${STAND_RENDERED}`, text: `"${GUN}"`, start: rendered.indexOf(GUN) - 1 },
    ]);
  });

  it('lists a child record on its own tab of its owner\'s file', async () => {
    const CELL = '000701:A.esp';
    const PERSISTENT = '000703:A.esp';
    const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cell.json';
    const cell = `{ "FormKey": "${CELL}", "Owner": "${GUN}", "Persistent": [{ "FormKey": "${PERSISTENT}", "Base": "${GUN}" }] }`;
    const { referencesAt } = references(
      [row(PERSISTENT, modA, 'Base')], { [key(CELL, modA)]: { file: CELL_FILE, text: cell }, [key(PERSISTENT, modA)]: { file: CELL_FILE, text: cell } },
    );

    expect(listed(await referencesAt(GUN))).toEqual([
      { uri: `modbench-child-record:${CELL_FILE}`, text: `"${GUN}"`, start: cell.lastIndexOf(GUN) - 1 },
    ]);
  });

  describe('when a copy cannot be listed', () => {
    const compiledPlugin = { [key(STAND, modA)]: { file: STAND_FILE, text: `{ "FormKey": "${STAND}", "Model": "${GUN}" }` } };
    const uris = ({ found }: Awaited<ReturnType<ReturnType<typeof references>['read']>>) => listed(found).map(({ uri }) => uri);

    it('leaves out nothing when every copy is listed', async () => {
      expect((await references([row(STAND, modA, 'Model')], compiledPlugin).read(GUN)).leftOut).toEqual([]);
    });

    it('lists the copies it can, and says why it left out one a plugin holds no copy of', async () => {
      const found = await references([row(STAND, modA, 'Model'), row(STAND, modB, 'Model')], compiledPlugin).read(GUN);

      expect([uris(found), found.leftOut]).toEqual([[`file:${STAND_FILE}`], [`B.esp (ModB) holds no ${STAND}.`]]);
    });

    it('lists the copies it can, and says why it left out one whose document fails to open', async () => {
      const found = await references(
        [row(STAND, modA, 'Model'), row(STAND, modB, 'Model')], { ...compiledPlugin, [key(STAND, modB)]: { rendered: STAND_RENDERED } },
      ).read(GUN);

      expect([uris(found), found.leftOut]).toEqual([[`file:${STAND_FILE}`], [`${STAND} in B.esp (ModB): The file is gone.`]]);
    });

    it('throws when mEdit cannot answer what references it', async () => {
      const { read } = references([], {}, { getReferencesInActiveOrCompiledPlugins: () => Promise.reject(new Error('mEdit is gone.')) });

      await expect(read(GUN)).rejects.toThrow('mEdit is gone.');
    });
  });
});
