import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import type { InstallationFileReader } from '../installationFileReader';
import { digestOf } from '../contentDigest';
import { stampOf } from '../../files';
import { hashIndex as hashIndexWith } from '../hashIndex';
import type { FileProblem, FileProblems } from '../../../ports/fileProblems';

vi.mock('../contentDigest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contentDigest')>();
  return { digestOf: vi.fn(actual.digestOf) };
});
vi.mock('../../files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../files')>();
  return { ...actual, stampOf: vi.fn(actual.stampOf) };
});

const HASH_OF_AAAA = 'Mr+EvxoNp0I=';
const HASH_OF_BBBB = 'M5WSec/sW34=';
const ENTRIES = ['a.esp', 'textures/b.dds'];

let root: string;
let folder: string;
let problems: Map<string, readonly FileProblem[]>;

const hashIndex = (at: string, reader: InstallationFileReader) => hashIndexWith(at, reader, problemsPanel);
const problemsPanel: FileProblems = {
  set: (file, list) => { if (list.length === 0) problems.delete(file); else problems.set(file, list); },
  clearAll: () => { problems.clear(); },
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'modbench-hashes-'));
  folder = join(root, 'index');
  problems = new Map();
  vi.mocked(digestOf).mockClear();
  vi.mocked(stampOf).mockClear();
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

function nextReadHeldUntilReleased(): { release: () => void } {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const actual = vi.mocked(digestOf).getMockImplementation();
  vi.mocked(digestOf).mockImplementationOnce(async (path) => {
    await held;
    return (actual ?? digestOf)(path);
  });
  return { release: () => release() };
}

const indexText = (): Promise<string> => readFile(join(folder, 'hashes.jsonl'), 'utf8').catch(() => '');

const clockAnHourPastEveryWrite = (): void => {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3_600_000 });
};

function counting(installationFileReader: InstallationFileReader): InstallationFileReader & { extracted: string[] } {
  const extracted: string[] = [];
  return { ...installationFileReader, extracted, extract: (path, dest) => { extracted.push(path); return installationFileReader.extract(path, dest); } };
}

describe('the sizes and hashes of the record index', () => {
  it('answers a game file\'s and an origin file\'s size and hash as mEdit\'s manifest carries it', async () => {
    const path = await fileHolding('Game.esm', 'aaaa');
    const index = hashIndex(folder, fakeInstallationFileReader([]));

    const answers = [await index.gameFileHash(path), await index.originFileHash(path)];

    expect(answers).toEqual([{ kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } }, { kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } }]);
  });

  it('answers a downloaded file\'s size and hash and each entry\'s, extracting it in its folder and leaving only the record index there', async () => {
    clockAnHourPastEveryWrite();
    const path = await fileHolding('Mod.7z', 'archive');

    const answer = await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).downloadedFileHash(path);

    expect(answer).toEqual({
      kind: 'read',
      answer: { size: 7, hash: '7R3YJUWF5oA=', entries: [{ path: 'a.esp', hash: '+rJPuyOy4u8=' }, { path: 'textures/b.dds', hash: 'uXAXn9wLC0k=' }] },
    });
    expect(await readdir(folder)).toEqual(['hashes.jsonl']);
  });

  it('keeps a downloaded file\'s hash and a game file\'s in the record index, and an origin file\'s nowhere but this session', async () => {
    clockAnHourPastEveryWrite();
    const downloadedFile = await fileHolding('Mod.7z', 'archive');
    const gameFile = await fileHolding('Game.esm', 'aaaa');
    const copy = await fileHolding('copy.dds', 'bbbb');
    const session = hashIndex(folder, fakeInstallationFileReader(ENTRIES));
    await Promise.all([session.downloadedFileHash(downloadedFile), session.gameFileHash(gameFile), session.originFileHash(copy)]);
    await session.originFileHash(copy);
    const readsInSession = vi.mocked(digestOf).mock.calls.filter(([path]) => path === copy).length;

    await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).originFileHash(copy);

    const text = await indexText();
    const written = (path: string): boolean => text.includes(JSON.stringify(path));
    expect([written(downloadedFile), written(gameFile), written(copy)]).toEqual([true, true, false]);
    expect([readsInSession, vi.mocked(digestOf).mock.calls.filter(([path]) => path === copy).length]).toEqual([1, 2]);
  });

  it('hashes a downloaded file\'s entries though its hash alone was asked before', async () => {
    clockAnHourPastEveryWrite();
    const path = await fileHolding('Mod.7z', 'archive');
    const index = hashIndex(folder, fakeInstallationFileReader(ENTRIES));
    await index.gameFileHash(path);

    const answer = await index.downloadedFileHash(path);

    expect(answer).toMatchObject({ kind: 'read', answer: { entries: ENTRIES.map((path) => ({ path })) } });
  });

  it('answers a file it cannot read, or a downloaded file the installation file reader cannot open, with the reason', async () => {
    const refusing: InstallationFileReader = { ...fakeInstallationFileReader([]), list: () => Promise.reject(new Error('Can not open the file as archive')) };
    const index = hashIndex(folder, refusing);

    const missing = await index.gameFileHash(join(root, 'none.dds'));
    const notAnInstallationFile = await index.downloadedFileHash(await fileHolding('Mod.esp', 'aaaa'));

    expect(missing).toEqual({ kind: 'unreadable', reason: expect.stringContaining('ENOENT') as unknown });
    expect(notAnInstallationFile).toEqual({ kind: 'unreadable', reason: 'Can not open the file as archive' });
    expect(await readdir(folder).catch(() => [])).toEqual([]);
  });

  it('answers a downloaded file whose entries differ only by case unreadable, naming them, and extracts none of it', async () => {
    const installationFileReader = counting(fakeInstallationFileReader(['textures/a.dds', 'Textures/A.DDS', 'b.esp']));

    const answer = await hashIndex(folder, installationFileReader).downloadedFileHash(await fileHolding('Mod.7z', 'archive'));

    expect(answer).toEqual({
      kind: 'unreadable',
      reason: 'Its entries textures/a.dds and Textures/A.DDS differ only by case, so one extracts over the other.',
    });
    expect(installationFileReader.extracted).toEqual([]);
  });

  it('reads no game file or downloaded file again whose stamp is unchanged, in this session or the next', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    const downloadedFile = await fileHolding('Mod.7z', 'archive');
    const installationFileReader = counting(fakeInstallationFileReader(ENTRIES));
    const session = hashIndex(folder, installationFileReader);
    const first = [await session.gameFileHash(file), await session.downloadedFileHash(downloadedFile)];
    const reads = vi.mocked(digestOf).mock.calls.length;

    const next = hashIndex(folder, installationFileReader);

    expect([await session.gameFileHash(file), await next.gameFileHash(file), await next.downloadedFileHash(downloadedFile)]).toEqual([...first.slice(0, 1), ...first]);
    expect(vi.mocked(digestOf).mock.calls).toHaveLength(reads);
    expect(installationFileReader.extracted).toEqual([downloadedFile]);
  });

  async function afterTheFileSystemClockThatStampsAChangePasses(file: string): Promise<void> {
    const { ctimeNs } = await stat(file, { bigint: true });
    const clock = await mkdtemp(join(tmpdir(), 'modbench-clock-'));
    const probe = join(clock, 'probe');
    do await writeFile(probe, ''); while ((await stat(probe, { bigint: true })).ctimeNs <= ctimeNs);
    await rm(clock, { recursive: true });
  }

  it('reads again a file another tool rewrote keeping its size and date modified', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    const kept = new Date('2020-01-01T00:00:00Z');
    await utimes(file, kept, kept);
    const index = hashIndex(folder, fakeInstallationFileReader([]));
    await index.gameFileHash(file);
    await afterTheFileSystemClockThatStampsAChangePasses(file);

    await writeFile(file, 'bbbb');
    await utimes(file, kept, kept);

    expect(await index.gameFileHash(file)).toEqual({ kind: 'read', answer: { size: 4, hash: HASH_OF_BBBB } });
  });

  it('reads again, and keeps no record of, a file whose stamp is within a clock tick of its read, as a write in that tick may keep the stamp', async () => {
    const file = await fileHolding('Game.esm', 'aaaa');
    const index = hashIndex(folder, fakeInstallationFileReader([]));
    await index.gameFileHash(file);

    await index.gameFileHash(file);
    await hashIndex(folder, fakeInstallationFileReader([])).gameFileHash(file);

    expect(vi.mocked(digestOf).mock.calls).toHaveLength(3);
  });

  it('reads a file once for two asks while its first read is still going', async () => {
    const file = await fileHolding('Game.esm', 'aaaa');
    const index = hashIndex(folder, fakeInstallationFileReader([]));
    const read = nextReadHeldUntilReleased();

    const first = index.originFileHash(file);
    await vi.waitUntil(() => vi.mocked(digestOf).mock.calls.length === 1);
    const second = index.originFileHash(file);
    await vi.waitUntil(() => vi.mocked(stampOf).mock.settledResults.length === 2);
    await new Promise(setImmediate);
    read.release();
    await Promise.all([first, second]);

    expect(vi.mocked(digestOf).mock.calls).toHaveLength(1);
  });

  it('skips a line of the record index it cannot read, as a crash mid-write leaves one, and trusts the lines it can', async () => {
    clockAnHourPastEveryWrite();
    const file = await fileHolding('Game.esm', 'aaaa');
    await hashIndex(folder, fakeInstallationFileReader([])).gameFileHash(file);
    await appendFile(join(folder, 'hashes.jsonl'), '["game","/torn');

    expect(await hashIndex(folder, fakeInstallationFileReader([])).gameFileHash(file)).toEqual({ kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } });
    expect(vi.mocked(digestOf).mock.calls).toHaveLength(1);
  });

  it('removes the extractions a crash left in its folder when it opens, before it extracts anything', async () => {
    const leftover = join(folder, 'entries-crashed');
    await mkdir(leftover, { recursive: true });
    await writeFile(join(leftover, 'texture.dds'), 'aaaa');
    const installationFileReader = fakeInstallationFileReader(ENTRIES);
    const extractingInto: string[][] = [];
    const watching: InstallationFileReader = { ...installationFileReader, extract: async (path, dest) => { extractingInto.push(await readdir(folder)); return installationFileReader.extract(path, dest); } };

    await hashIndex(folder, watching).downloadedFileHash(await fileHolding('Mod.7z', 'archive'));

    expect(extractingInto.flat()).not.toContain('entries-crashed');
    expect(await readdir(folder)).not.toContain('entries-crashed');
  });

  it('extracts one downloaded file at a time, however many are asked at once', async () => {
    const installationFileReader = fakeInstallationFileReader(ENTRIES);
    let extracting = 0;
    let mostAtOnce = 0;
    const overlapping: InstallationFileReader = {
      ...installationFileReader,
      extract: async (path, dest) => {
        mostAtOnce = Math.max(mostAtOnce, ++extracting);
        await new Promise((resolve) => setImmediate(resolve));
        await installationFileReader.extract(path, dest);
        extracting--;
      },
    };
    const index = hashIndex(folder, overlapping);

    await Promise.all(['A.7z', 'B.7z', 'C.7z'].map(async (name) => index.downloadedFileHash(await fileHolding(name, 'archive'))));

    expect(mostAtOnce).toBe(1);
  });

  describe('every downloaded file asked', () => {
    const MOD_ENTRIES = [{ path: 'a.esp', hash: '+rJPuyOy4u8=' }, { path: 'textures/b.dds', hash: 'uXAXn9wLC0k=' }];

    it('answers each with its entries, hashing one at a time only those the index lacks, and hears how many are left before each', async () => {
      clockAnHourPastEveryWrite();
      const [held, lackedFirst, lackedNext] = await Promise.all([fileHolding('Held.7z', 'archive'), fileHolding('A.7z', 'archive'), fileHolding('B.7z', 'archive')]);
      await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).downloadedFileHash(held);
      const next = counting(fakeInstallationFileReader(ENTRIES));
      const left: number[] = [];

      const answer = await hashIndex(folder, next).downloadedFilesHashed([held, lackedFirst, lackedNext], { onHashing: (count) => left.push(count) });

      expect(answer).toEqual({ files: [held, lackedFirst, lackedNext].map((path) => ({ path, size: 7, hash: '7R3YJUWF5oA=', entries: MOD_ENTRIES })), notes: [] });
      expect([next.extracted, left]).toEqual([[lackedFirst, lackedNext], [2, 1]]);
    });

    it('keeps each hash it finished when its signal aborts part way, so the next ask hashes none of those again', async () => {
      clockAnHourPastEveryWrite();
      const paths = await Promise.all(['A.7z', 'B.7z', 'C.7z'].map((name) => fileHolding(name, 'archive')));
      const cancel = new AbortController();
      await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).downloadedFilesHashed(paths, {
        signal: cancel.signal, onHashing: () => { cancel.abort(); },
      });
      const next = counting(fakeInstallationFileReader(ENTRIES));

      await hashIndex(folder, next).downloadedFilesHashed(paths);

      expect(next.extracted).toEqual(paths.slice(1));
    });

    it('hashes no file again that it could not hash while its stamp holds in this session, and a reload hashes it again', async () => {
      clockAnHourPastEveryWrite();
      const listed: string[] = [];
      const refusing: InstallationFileReader = { ...fakeInstallationFileReader([]), list: (path) => { listed.push(path); return Promise.reject(new Error('Can not open the file as archive')); } };
      const corrupt = await fileHolding('Corrupt.7z', 'archive');
      const session = hashIndex(folder, refusing);
      await session.downloadedFilesHashed([corrupt]);

      await session.downloadedFilesHashed([corrupt]);
      const afterSecondAsk = listed.length;
      await hashIndex(folder, refusing).downloadedFilesHashed([corrupt]);

      expect([afterSecondAsk, listed.length, await indexText()]).toEqual([1, 2, '']);
    });

    it('shows a file it could not hash as a problem on that file, until it hashes or is gone', async () => {
      clockAnHourPastEveryWrite();
      const reading: InstallationFileReader = { ...fakeInstallationFileReader(ENTRIES), list: () => Promise.reject(new Error('Can not open the file as archive')) };
      const file = await fileHolding('Mod.7z', 'archive');
      await hashIndex(folder, reading).downloadedFilesHashed([file]);
      const whileBroken = new Map(problems);
      await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).downloadedFilesHashed([file]);
      const afterFix = new Map(problems);
      const session = hashIndex(folder, reading);
      await session.downloadedFilesHashed([file]);
      await rm(file);
      await session.downloadedFilesHashed([file]);

      expect([whileBroken, afterFix, problems]).toEqual([new Map([[file, [{ message: 'Can not open the file as archive' }]]]), new Map(), new Map()]);
    });

    it('says why the hash index could not be written, as the next run hashes those files again', async () => {
      clockAnHourPastEveryWrite();
      await mkdir(join(folder, 'hashes.jsonl'), { recursive: true });
      const path = await fileHolding('Mod.7z', 'archive');

      const answer = await hashIndex(folder, fakeInstallationFileReader(ENTRIES)).downloadedFilesHashed([path]);

      expect(answer).toEqual({
        files: [{ path, size: 7, hash: '7R3YJUWF5oA=', entries: MOD_ENTRIES }],
        notes: [expect.stringMatching(/^the hash index could not be written, so the next run hashes these files again: .*EISDIR/) as unknown],
      });
    });

    it('answers no file it could not read, and notes none of them', async () => {
      const refusing: InstallationFileReader = { ...fakeInstallationFileReader([]), list: () => Promise.reject(new Error('Can not open the file as archive')) };
      const [gone, notAnInstallationFile] = [join(root, 'Gone.7z'), await fileHolding('Mod.esp', 'aaaa')];

      const answer = await hashIndex(folder, refusing).downloadedFilesHashed([gone, notAnInstallationFile]);

      expect(answer).toEqual({ files: [], notes: [] });
      expect([...problems.keys()]).toEqual([notAnInstallationFile]);
    });
  });
});
