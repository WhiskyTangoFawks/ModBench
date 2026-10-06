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
import { childRecordUri, copyOf, renderedDocumentUri } from '../recordDocument';

const GUN = '000801:A.esp';
const modA = { name: 'A.esp', origin: 'ModA' };
const copy = { formKey: GUN, plugin: modA };
const NAME = 'Gun - 000801_A.esp.json';
const CELL_FILE = '/mods/ModA/plugin-source/A.esp/Cells/Cell.json';

describe('a rendered document\'s address', () => {
  it('names the copy by its FormKey and plugin, and ends in the name its file would have', () => {
    const uri = renderedDocumentUri(copy, NAME);

    expect(copyOf(uri)).toEqual(copy);
    expect(uri.path.split('/').at(-1)).toBe(NAME);
  });

  it('survives a plugin address containing "/"', () => {
    const odd = { formKey: '000801:Mod/A.esp', plugin: { name: 'Mod/A.esp', origin: 'Mods/A' } };

    expect(copyOf(renderedDocumentUri(odd, NAME))).toEqual(odd);
  });

  it('refuses an address that states no plugin name, naming what it lacks', () => {
    const uri = vscode.Uri.from({ scheme: 'modbench-rendered', path: '/ModA/A.esp/Gun.json', query: 'formKey=000801%3AA.esp&origin=ModA' });

    expect(() => copyOf(uri)).toThrow('The document /ModA/A.esp/Gun.json states no name.');
  });

  it('tells apart the copies of two plugins of one file name from different origins', () => {
    expect(renderedDocumentUri(copy, NAME))
      .not.toEqual(renderedDocumentUri({ formKey: GUN, plugin: { name: 'A.esp', origin: 'ModB' } }, NAME));
  });
});

describe('a child record\'s address', () => {
  it('is apart from its sibling\'s, which shares its file', () => {
    const placed = { formKey: '000803:A.esp', plugin: modA };

    expect(childRecordUri(placed, CELL_FILE)).not.toEqual(childRecordUri({ formKey: '000804:A.esp', plugin: modA }, CELL_FILE));
  });
});
