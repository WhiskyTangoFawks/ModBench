import { describe, expect, it, vi } from 'vitest';
import { Uri } from '../../test/vscodeMock';

const world = vi.hoisted(() => ({
  documents: [] as { uri: { scheme: string; fsPath: string }; getText(): string }[],
  opened: [] as string[],
  disk: new Map<string, string>(),
}));
vi.mock('vscode', () => ({
  Uri,
  FileSystemError: class extends Error { constructor(readonly code: string) { super(code); } },
  workspace: {
    get textDocuments() { return world.documents; },
    openTextDocument: (uri: { fsPath: string }) => { world.opened.push(uri.fsPath); return Promise.reject(new Error('opened a document')); },
    fs: {
      readFile: (uri: { fsPath: string }) => {
        const text = world.disk.get(uri.fsPath);
        return text === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(new TextEncoder().encode(text));
      },
    },
  },
}));

import { heldOrSavedText } from '../fileText';

const FILE = '/source/Mod/Names.esp/Quest.json';
const document = (text: string, scheme = 'file') => ({ uri: { scheme, fsPath: FILE }, getText: () => text });

describe('heldOrSavedText', () => {
  it('reads an open file from its document', async () => {
    world.documents = [document('unsaved')];
    world.disk = new Map([[FILE, 'disk']]);

    expect(await heldOrSavedText(FILE)).toBe('unsaved');
  });

  it('reads a closed file from disk, and opens no document', async () => {
    world.documents = [];
    world.opened = [];
    world.disk = new Map([[FILE, 'disk']]);

    expect([await heldOrSavedText(FILE), world.opened]).toEqual(['disk', []]);
  });

  it('reads the file, not the document of another scheme that shows the same path', async () => {
    world.documents = [document('the version in git', 'git')];
    world.disk = new Map([[FILE, 'disk']]);

    expect(await heldOrSavedText(FILE)).toBe('disk');
  });
});
