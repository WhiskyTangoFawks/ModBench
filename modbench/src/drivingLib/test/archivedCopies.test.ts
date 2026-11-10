import { describe, it, expect } from 'vitest';
import { ArchivedCopies, HASH_BATCH_BYTES, type ArchiveCopyReader, type FileRead, type FileStamp } from '../archivedCopies';
import type { ReadFailed } from '../../wire/readFailed';

type Answer = Awaited<ReturnType<ArchiveCopyReader['getArchiveCopies']>>;

class ScriptedReader implements ArchiveCopyReader {
  readonly asked: unknown[][] = [];
  private readonly answers: Answer[] = [];

  answerOnce(answer: Answer | ReadFailed): void { this.answers.push(answer); }

  getArchiveCopies(...args: Parameters<ArchiveCopyReader['getArchiveCopies']>): Promise<Answer> {
    this.asked.push(args);
    return Promise.resolve(this.answers.shift() ?? []);
  }
}

const ARCHIVE = '/mods/A/A - Main.ba2';
const OTHER = '/mods/B/B.ba2';
const at = (archive: string, file: string) => ({ gameRelease: 'Fallout4', archive, file });
const sized = (file: string, size: number) => ({ file, size, hash: null });
const hashed = (file: string, size: number, hash: string) => ({ file, size, hash });

function reading(stampOf: (path: string) => FileRead<FileStamp> = () => ({ kind: 'read', answer: { size: 9n, modifiedNs: 5n } })) {
  const medit = new ScriptedReader();
  return { medit, copies: new ArchivedCopies(medit, (path) => Promise.resolve(stampOf(path))) };
}

describe('the stamps of copies in archives', () => {
  it('reads each archived copy as its size and its archive\'s date modified, asking each archive once, for no bytes', async () => {
    const { medit, copies } = reading();
    medit.answerOnce([sized('a.nif', 3), sized('b.nif', 4)]);
    medit.answerOnce([sized('a.nif', 3)]);

    const read = await copies.stamps([at(ARCHIVE, 'a.nif'), at(OTHER, 'a.nif'), at(ARCHIVE, 'b.nif')]);

    expect(medit.asked).toEqual([['Fallout4', ARCHIVE, ['a.nif', 'b.nif'], false], ['Fallout4', OTHER, ['a.nif'], false]]);
    expect(read).toEqual([
      { kind: 'read', answer: { size: 3n, modifiedNs: 5n } },
      { kind: 'read', answer: { size: 3n, modifiedNs: 5n } },
      { kind: 'read', answer: { size: 4n, modifiedNs: 5n } },
    ]);
  });

  it('asks an archive again only for a file it has not answered, or once its stamp changes', async () => {
    let modifiedNs = 5n;
    const { medit, copies } = reading(() => ({ kind: 'read', answer: { size: 9n, modifiedNs } }));
    medit.answerOnce([sized('a.nif', 3)]);
    medit.answerOnce([sized('b.nif', 4)]);
    medit.answerOnce([sized('a.nif', 3)]);

    await copies.stamps([at(ARCHIVE, 'a.nif')]);
    await copies.stamps([at(ARCHIVE, 'a.nif'), at(ARCHIVE, 'b.nif')]);
    modifiedNs = 6n;
    await copies.stamps([at(ARCHIVE, 'a.nif')]);

    expect(medit.asked.map(([, , files]) => files)).toEqual([['a.nif'], ['b.nif'], ['a.nif']]);
  });

  it('answers why a copy cannot be read: its archive\'s stamp, mEdit\'s read, or a file the archive does not hold', async () => {
    const { medit, copies } = reading((path) => (path === OTHER ? { kind: 'unreadable', reason: 'gone' } : { kind: 'read', answer: { size: 9n, modifiedNs: 5n } }));
    medit.answerOnce({ failed: 'refused', refusal: 'it is no BA2' });
    medit.answerOnce([]);

    const failed = await copies.stamps([at(ARCHIVE, 'a.nif'), at(OTHER, 'a.nif')]);
    const missing = await copies.stamps([at(ARCHIVE, 'a.nif')]);

    expect([...failed, ...missing]).toEqual([
      { kind: 'unreadable', reason: 'it is no BA2' },
      { kind: 'unreadable', reason: 'gone' },
      { kind: 'unreadable', reason: `${ARCHIVE} does not hold a.nif.` },
    ]);
  });
});

describe('the hashes of copies in archives', () => {
  it('reads the bytes of the copies asked for in batches of a bounded size, keeping each batch it read', async () => {
    const big = HASH_BATCH_BYTES / 2 + 1;
    const { medit, copies } = reading();
    medit.answerOnce([sized('a.nif', big), sized('b.nif', big), sized('c.nif', 1)]);
    await copies.stamps([at(ARCHIVE, 'a.nif'), at(ARCHIVE, 'b.nif'), at(ARCHIVE, 'c.nif')]);
    medit.answerOnce([hashed('a.nif', big, 'ha')]);
    medit.answerOnce({ failed: 'timed-out' });

    const read = await copies.hashes([at(ARCHIVE, 'a.nif'), at(ARCHIVE, 'b.nif'), at(ARCHIVE, 'c.nif')]);
    medit.answerOnce([hashed('b.nif', big, 'hb'), hashed('c.nif', 1, 'hc')]);
    const again = await copies.hashes([at(ARCHIVE, 'a.nif'), at(ARCHIVE, 'b.nif'), at(ARCHIVE, 'c.nif')]);

    expect(medit.asked.slice(1).map(([, , files, hashedToo]) => [files, hashedToo])).toEqual([
      [['a.nif'], true], [['b.nif', 'c.nif'], true], [['b.nif', 'c.nif'], true],
    ]);
    expect(read).toEqual([
      { kind: 'read', answer: 'ha' },
      { kind: 'unreadable', reason: 'mEdit did not answer in time.' },
      { kind: 'unreadable', reason: 'mEdit did not answer in time.' },
    ]);
    expect(again).toEqual([{ kind: 'read', answer: 'ha' }, { kind: 'read', answer: 'hb' }, { kind: 'read', answer: 'hc' }]);
  });
});
