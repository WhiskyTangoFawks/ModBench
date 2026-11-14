import { describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

const world = vi.hoisted(() => ({ documents: [] as { uri: { fsPath: string }; getText(): string }[], opened: [] as string[] }));
vi.mock('vscode', () => ({
  Uri,
  workspace: {
    get textDocuments() { return world.documents; },
    openTextDocument: (uri: { fsPath: string }) => { world.opened.push(uri.fsPath); return Promise.reject(new Error('opened a document')); },
  },
}));

import { sourceFileText } from '../sourceFileText';

const FILE = '/source/Mod/Names.esp/Quest.json';

describe('sourceFileText', () => {
  it('reads an open file from its document', async () => {
    world.documents = [{ uri: { fsPath: FILE }, getText: () => 'unsaved' }];

    expect(await sourceFileText(() => Promise.resolve('disk'))(FILE)).toBe('unsaved');
  });

  it('reads a closed file from disk, and opens no document', async () => {
    world.documents = [];

    expect([await sourceFileText((path) => Promise.resolve(`disk of ${path}`))(FILE), world.opened]).toEqual([`disk of ${FILE}`, []]);
  });

  it('reads a file that is gone as no text', async () => {
    world.documents = [];

    expect(await sourceFileText(() => Promise.resolve(undefined))(FILE)).toBe('');
  });
});
