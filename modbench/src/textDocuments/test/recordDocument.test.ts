import { DATA_DIRECTORY_ORIGIN } from '../../wire/pluginAddress';
import { describe, it, expect, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ Uri }));

import * as vscode from 'vscode';
import { copyDocument, copyOf, type RecordDocumentClient } from '../recordDocument';
import type { RecordCopy } from '../../wire/recordCopy';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const copy = { formKey: GUN, plugin: modA };
const NAME = 'Gun - 000801_A.esp.json';
const CELL_FILE = '/source/ModA/plugin-source/A.esp/Cells/Cell.json';

const nonCompiledPlugin = (renderedFileName: string): RecordDocumentClient => ({
  getRecordOwner: () => Promise.resolve(undefined),
  getCopyDocument: () => Promise.resolve({ kind: 'Rendered', location: renderedFileName }),
});

const carriedIn = (path: string): RecordDocumentClient => ({
  ...nonCompiledPlugin(NAME),
  getCopyDocument: () => Promise.resolve({ kind: 'ContainersFile', location: path }),
});

const ownFile = (path: string): RecordDocumentClient => ({
  ...nonCompiledPlugin(NAME),
  getCopyDocument: () => Promise.resolve({ kind: 'OwnFile', location: path }),
});

const holdingNone: RecordDocumentClient = { ...nonCompiledPlugin(NAME), getCopyDocument: () => Promise.resolve(null) };

const uriOf = async (client: RecordDocumentClient, of: RecordCopy): Promise<vscode.Uri> => {
  const document = await copyDocument(client, of);
  if (!('uri' in document)) throw new Error(document.refused);
  return document.uri;
};

describe('a rendered document\'s address', () => {
  it('names the copy by its FormKey and plugin, and ends in the name its file would have', async () => {
    const uri = await uriOf(nonCompiledPlugin(NAME), copy);

    expect(copyOf(uri)).toEqual(copy);
    expect(uri.path.split('/').at(-1)).toBe(NAME);
  });

  it('survives a plugin address containing "/"', async () => {
    const odd = { formKey: '000801:Mod/A.esp', plugin: { name: 'Mod/A.esp', origin: 'Mods/A' } };

    expect(copyOf(await uriOf(nonCompiledPlugin(NAME), odd))).toEqual(odd);
  });

  it('keeps the game folder\'s origin whole, as one segment of the path', async () => {
    const game = { formKey: GUN, plugin: { name: 'A.esp', origin: DATA_DIRECTORY_ORIGIN } };

    const uri = await uriOf(nonCompiledPlugin(NAME), game);

    expect(uri.path.split('/').slice(1)).not.toContain('');
    expect(copyOf(uri)).toEqual(game);
  });

  it('refuses an address that states no plugin name, naming what it lacks', () => {
    const uri = vscode.Uri.from({ scheme: 'modbench-rendered', path: '/ModA/A.esp/Gun.json', query: 'formKey=000801%3AA.esp&origin=ModA' });

    expect(() => copyOf(uri)).toThrow('The document /ModA/A.esp/Gun.json states no name.');
  });

  it('tells apart the copies of two plugins of one file name from different origins', async () => {
    expect(await uriOf(nonCompiledPlugin(NAME), copy))
      .not.toEqual(await uriOf(nonCompiledPlugin(NAME), { formKey: GUN, plugin: { name: 'A.esp', origin: 'ModB' } }));
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
