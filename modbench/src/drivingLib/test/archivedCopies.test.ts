import { describe, it, expect } from 'vitest';
import { ArchivedCopies, type ArchiveCopyReader, type FileRead, type FileStamp } from '../archivedCopies';
import type { ReadFailed } from '../../wire/readFailed';

type Answer = Awaited<ReturnType<ArchiveCopyReader['getArchiveCopies']>>;

class ScriptedReader implements ArchiveCopyReader {
  readonly calls: { readonly method: string; readonly args: unknown[] }[] = [];
  private readonly answers: Answer[] = [];

  setQueryAnswerOnce(_method: 'getArchiveCopies', answer: Answer): void { this.answers.push(answer); }
  setQueryFailureOnce(_method: 'getArchiveCopies', failure: ReadFailed): void { this.answers.push(failure); }

  getArchiveCopies(...args: Parameters<ArchiveCopyReader['getArchiveCopies']>): Promise<Answer> {
    this.calls.push({ method: 'getArchiveCopies', args });
    return Promise.resolve(this.answers.shift() ?? []);
  }
}

const ARCHIVE = '/mods/A/A - Main.ba2';
const OTHER = '/mods/B/B.ba2';
const at = (archive: string, file: string) => ({ gameRelease: 'Fallout4', archive, file });

function reading(stampOf: (path: string) => FileRead<FileStamp> = () => ({ kind: 'read', answer: { size: 9n, modifiedNs: 5n } })) {
  const medit = new ScriptedReader();
  const copies = new ArchivedCopies(medit, (path) => Promise.resolve(stampOf(path)));
  const asked = () => medit.calls.filter((call) => call.method === 'getArchiveCopies').map((call) => call.args);
  return { medit, copies, asked };
}

describe('the copies of files in archives', () => {
  it('reads each archived copy as its size, its archive\'s date modified and its hash, asking each archive once', async () => {
    const { medit, copies, asked } = reading();
    medit.setQueryAnswerOnce('getArchiveCopies', [{ file: 'a.nif', size: 3, hash: 'h1' }, { file: 'b.nif', size: 4, hash: 'h2' }]);
    medit.setQueryAnswerOnce('getArchiveCopies', [{ file: 'a.nif', size: 3, hash: 'h1' }]);

    const read = await copies.read([at(ARCHIVE, 'a.nif'), at(OTHER, 'a.nif'), at(ARCHIVE, 'b.nif')]);

    expect(asked()).toEqual([['Fallout4', ARCHIVE, ['a.nif', 'b.nif']], ['Fallout4', OTHER, ['a.nif']]]);
    expect(read).toEqual([
      { kind: 'read', answer: { size: 3n, modifiedNs: 5n, hash: 'h1' } },
      { kind: 'read', answer: { size: 3n, modifiedNs: 5n, hash: 'h1' } },
      { kind: 'read', answer: { size: 4n, modifiedNs: 5n, hash: 'h2' } },
    ]);
  });

  it('asks an archive again only for a file it has not answered, or once its stamp changes', async () => {
    let modifiedNs = 5n;
    const { medit, copies, asked } = reading(() => ({ kind: 'read', answer: { size: 9n, modifiedNs } }));
    medit.setQueryAnswerOnce('getArchiveCopies', [{ file: 'a.nif', size: 3, hash: 'h1' }]);
    medit.setQueryAnswerOnce('getArchiveCopies', [{ file: 'b.nif', size: 4, hash: 'h2' }]);
    medit.setQueryAnswerOnce('getArchiveCopies', [{ file: 'a.nif', size: 3, hash: 'h1' }]);

    await copies.read([at(ARCHIVE, 'a.nif')]);
    await copies.read([at(ARCHIVE, 'a.nif'), at(ARCHIVE, 'b.nif')]);
    modifiedNs = 6n;
    await copies.read([at(ARCHIVE, 'a.nif')]);

    expect(asked()).toEqual([['Fallout4', ARCHIVE, ['a.nif']], ['Fallout4', ARCHIVE, ['b.nif']], ['Fallout4', ARCHIVE, ['a.nif']]]);
  });

  it('answers why a copy cannot be read: its archive\'s stamp, mEdit\'s read, or a file the archive does not hold', async () => {
    const { medit, copies } = reading((path) => (path === OTHER ? { kind: 'unreadable', reason: 'gone' } : { kind: 'read', answer: { size: 9n, modifiedNs: 5n } }));
    medit.setQueryFailureOnce('getArchiveCopies', { failed: 'refused', refusal: 'it is no BA2' });
    medit.setQueryAnswerOnce('getArchiveCopies', []);

    const failed = await copies.read([at(ARCHIVE, 'a.nif'), at(OTHER, 'a.nif')]);
    const missing = await copies.read([at(ARCHIVE, 'a.nif')]);

    expect([...failed, ...missing]).toEqual([
      { kind: 'unreadable', reason: 'it is no BA2' },
      { kind: 'unreadable', reason: 'gone' },
      { kind: 'unreadable', reason: `${ARCHIVE} does not hold a.nif.` },
    ]);
  });
});
