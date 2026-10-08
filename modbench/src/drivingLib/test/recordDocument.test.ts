import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
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

import * as vscode from 'vscode';
import { copyDocument, copyOf, type RecordCopy, type RecordDocumentClient } from '../recordDocument';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const copy = { formKey: GUN, plugin: modA };
const NAME = 'Gun - 000801_A.esp.json';
const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';

const untracked = (renderedFileName: string): RecordDocumentClient => ({
  getRecordOwner: () => Promise.resolve(undefined),
  getCopyDocument: () => Promise.resolve({ path: null, isContainersDocument: false, renderedFileName }),
});

const carriedIn = (path: string): RecordDocumentClient => ({
  ...untracked(NAME),
  getCopyDocument: () => Promise.resolve({ path, isContainersDocument: true, renderedFileName: null }),
});

const ownFile = (path: string): RecordDocumentClient => ({
  ...untracked(NAME),
  getCopyDocument: () => Promise.resolve({ path, isContainersDocument: false, renderedFileName: null }),
});

const holdingNone: RecordDocumentClient = { ...untracked(NAME), getCopyDocument: () => Promise.resolve(null) };

const uriOf = async (client: RecordDocumentClient, of: RecordCopy): Promise<vscode.Uri> => {
  const document = await copyDocument(client, of);
  if (!('uri' in document)) throw new Error(document.refused);
  return document.uri;
};

describe('a rendered document\'s address', () => {
  it('names the copy by its FormKey and plugin, and ends in the name its file would have', async () => {
    const uri = await uriOf(untracked(NAME), copy);

    expect(copyOf(uri)).toEqual(copy);
    expect(uri.path.split('/').at(-1)).toBe(NAME);
  });

  it('survives a plugin address containing "/"', async () => {
    const odd = { formKey: '000801:Mod/A.esp', plugin: { name: 'Mod/A.esp', origin: 'Mods/A' } };

    expect(copyOf(await uriOf(untracked(NAME), odd))).toEqual(odd);
  });

  it('keeps the game folder\'s origin whole, as one segment of the path', async () => {
    const game = { formKey: GUN, plugin: { name: 'A.esp', origin: DATA_DIRECTORY_ORIGIN } };

    const uri = await uriOf(untracked(NAME), game);

    expect(uri.path.split('/').slice(1)).not.toContain('');
    expect(copyOf(uri)).toEqual(game);
  });

  it('refuses an address that states no plugin name, naming what it lacks', () => {
    const uri = vscode.Uri.from({ scheme: 'modbench-rendered', path: '/ModA/A.esp/Gun.json', query: 'formKey=000801%3AA.esp&origin=ModA' });

    expect(() => copyOf(uri)).toThrow('The document /ModA/A.esp/Gun.json states no name.');
  });

  it('tells apart the copies of two plugins of one file name from different origins', async () => {
    expect(await uriOf(untracked(NAME), copy))
      .not.toEqual(await uriOf(untracked(NAME), { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModB' } }));
  });
});

describe('a child record\'s address', () => {
  it('is apart from its sibling\'s, which shares its file', async () => {
    const placed = { formKey: '000803:A.esp', plugin: modA };

    expect(await uriOf(carriedIn(CELL_FILE), placed)).not.toEqual(await uriOf(carriedIn(CELL_FILE), { formKey: '000804:A.esp', plugin: modA }));
  });
});

describe("a copy's document", () => {
  it("is the copy's own file when the file is the record's whole document", async () => {
    const uri = await uriOf(ownFile(CELL_FILE), copy);

    expect(uri.scheme).toBe('file');
    expect(uri.path).toBe(CELL_FILE);
  });

  it("is the container's file, in the child scheme, when the record sits inside it", async () => {
    const uri = await uriOf(carriedIn(CELL_FILE), copy);

    expect(uri.scheme).toBe('modbench-child-record');
    expect(uri.path).toBe(CELL_FILE);
    expect(copyOf(uri)).toEqual(copy);
  });

  it('is a refusal naming the plugin when it holds no copy', async () => {
    expect(await copyDocument(holdingNone, copy)).toEqual({ refused: 'A.esp (ModA) holds no 000801:A.esp.' });
  });
});
