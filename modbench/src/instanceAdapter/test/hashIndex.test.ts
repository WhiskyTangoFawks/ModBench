import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeArchiveReader } from '../../test/fakeArchiveReader';
import type { ArchiveReader } from '../archiveReader';
import { digestOf } from '../contentDigest';
import { hashIndex } from '../hashIndex';

vi.mock('../contentDigest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contentDigest')>();
  return { digestOf: vi.fn(actual.digestOf) };
});

const HASH_OF_AAAA = 'Mr+EvxoNp0I=';
const HASH_OF_BBBB = 'M5WSec/sW34=';
const ENTRIES = ['a.esp', 'textures/b.dds'];

let root: string;
let build: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-hashes-'));
  build = join(root, 'build');
  vi.mocked(digestOf).mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function fileHolding(name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body);
  return path;
}

const clockAnHourPastEveryWrite = (): void => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
};

function counting(archives: ArchiveReader): ArchiveReader & { extracted: string[] } {
  const extracted: string[] = [];
  return { ...archives, extracted, extract: (path, dest) => { extracted.push(path); return archives.extract(path, dest); } };
}

describe('hashIndex', () => {
  it('answers a file\'s size and its hash as mEdit\'s manifest carries it', async () => {
    const path = await fileHolding('Game.esm', 'aaaa');

    expect(await hashIndex(build, fakeArchiveReader([])).fileHash(path)).toEqual({ kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } });
  });

  it('answers a downloaded file\'s size and hash and each entry\'s, extracting it in the build folder and leaving only the index there', async () => {
    clockAnHourPastEveryWrite();
    const path = await fileHolding('Mod.7z', 'archive');

    const answer = await hashIndex(build, fakeArchiveReader(ENTRIES)).downloadedFileHash(path);

    expect(answer).toEqual({
      kind: 'read',
      answer: { size: 7, hash: '7R3YJUWF5oA=', entries: [{ path: 'a.esp', hash: '+rJPuyOy4u8=' }, { path: 'textures/b.dds', hash: 'uXAXn9wLC0k=' }] },
    });
    expect(await readdir(build)).toHaveLength(1);
  });

  it('hashes a downloaded file\'s entries though its hash alone was asked before', async () => {
    clockAnHourPastEveryWrite();
    const path = await fileHolding('Mod.7z', 'archive');
    const index = hashIndex(build, fakeArchiveReader(ENTRIES));
    await index.fileHash(path);

    const answer = await index.downloadedFileHash(path);

    expect(answer.kind === 'read' && answer.answer.entries.map((entry) => entry.path)).toEqual(ENTRIES);
  });

  it('answers a file it cannot read, or a downloaded file the archive reader cannot open, with the reason', async () => {
    const refusing: ArchiveReader = { ...fakeArchiveReader([]), list: () => Promise.reject(new Error('Can not open the file as archive')) };
    const index = hashIndex(build, refusing);

    const missing = await index.fileHash(join(root, 'none.dds'));
    const notAnArchive = await index.downloadedFileHash(await fileHolding('Mod.esp', 'aaaa'));

    expect(missing.kind === 'unreadable' && missing.reason).toContain('ENOENT');
    expect(notAnArchive).toEqual({ kind: 'unreadable', reason: 'Can not open the file as archive' });
    expect(await readdir(build).catch(() => [])).toEqual([]);
  });

  it('reads no file again whose stamp is unchanged, in this session or the next', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    const download = await fileHolding('Mod.7z', 'archive');
    const archives = counting(fakeArchiveReader(ENTRIES));
    const session = hashIndex(build, archives);
    const first = [await session.fileHash(file), await session.downloadedFileHash(download)];
    const reads = vi.mocked(digestOf).mock.calls.length;

    const next = hashIndex(build, archives);

    expect([await session.fileHash(file), await next.fileHash(file), await next.downloadedFileHash(download)]).toEqual([...first.slice(0, 1), ...first]);
    expect(vi.mocked(digestOf).mock.calls).toHaveLength(reads);
    expect(archives.extracted).toEqual([download]);
  });

  async function afterTheFileSystemClockThatStampsAChangePasses(file: string): Promise<void> {
    const { ctimeNs } = await stat(file, { bigint: true });
    const folder = await mkdtemp(join(tmpdir(), 'modbench-clock-'));
    const probe = join(folder, 'probe');
    do await writeFile(probe, ''); while ((await stat(probe, { bigint: true })).ctimeNs <= ctimeNs);
    await rm(folder, { recursive: true });
  }

  it('reads again a file another tool rewrote keeping its size and date modified', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    const kept = new Date('2020-01-01T00:00:00Z');
    await utimes(file, kept, kept);
    const index = hashIndex(build, fakeArchiveReader([]));
    await index.fileHash(file);
    await afterTheFileSystemClockThatStampsAChangePasses(file);

    await writeFile(file, 'bbbb');
    await utimes(file, kept, kept);

    expect(await index.fileHash(file)).toEqual({ kind: 'read', answer: { size: 4, hash: HASH_OF_BBBB } });
  });

  it('reads again, and keeps no record of, a file whose stamp is within a clock tick of its read, as a write in that tick may keep the stamp', async () => {
    const file = await fileHolding('Game.esm', 'aaaa');
    const index = hashIndex(build, fakeArchiveReader([]));
    await index.fileHash(file);

    await index.fileHash(file);
    await hashIndex(build, fakeArchiveReader([])).fileHash(file);

    expect(vi.mocked(digestOf).mock.calls).toHaveLength(3);
  });

  it('reads a file once for two asks while its first read is still going', async () => {
    const file = await fileHolding('Game.esm', 'aaaa');
    const index = hashIndex(build, fakeArchiveReader([]));

    await Promise.all([index.fileHash(file), index.fileHash(file)]);

    expect(vi.mocked(digestOf).mock.calls).toHaveLength(1);
  });

  it('skips a line of the index it cannot read, as a crash mid-write leaves one, and trusts the lines it can', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    await hashIndex(build, fakeArchiveReader([])).fileHash(file);
    const [indexFile = ''] = await readdir(build);
    await appendFile(join(build, indexFile), '["file","/torn');

    expect(await hashIndex(build, fakeArchiveReader([])).fileHash(file)).toEqual({ kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } });
    expect(vi.mocked(digestOf).mock.calls).toHaveLength(1);
  });

  it('removes the extractions a crash left in the build folder when it opens, before it extracts anything', async () => {
    const leftover = join(build, 'entries-crashed');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'texture.dds'), 'aaaa');
    const archives = fakeArchiveReader(ENTRIES);
    const extractingInto: string[][] = [];
    const watching: ArchiveReader = { ...archives, extract: async (path, dest) => { extractingInto.push(await readdir(build)); return archives.extract(path, dest); } };

    await hashIndex(build, watching).downloadedFileHash(await fileHolding('Mod.7z', 'archive'));

    expect(extractingInto.flat()).not.toContain('entries-crashed');
    expect(await readdir(build)).not.toContain('entries-crashed');
  });

  it('extracts one downloaded file at a time, however many are asked at once', async () => {
    const archives = fakeArchiveReader(ENTRIES);
    let extracting = 0;
    let mostAtOnce = 0;
    const overlapping: ArchiveReader = {
      ...archives,
      extract: async (path, dest) => {
        mostAtOnce = Math.max(mostAtOnce, ++extracting);
        await new Promise((resolve) => setImmediate(resolve));
        await archives.extract(path, dest);
        extracting--;
      },
    };
    const index = hashIndex(build, overlapping);

    await Promise.all(['A.7z', 'B.7z', 'C.7z'].map(async (name) => index.downloadedFileHash(await fileHolding(name, 'archive'))));

    expect(mostAtOnce).toBe(1);
  });
});
