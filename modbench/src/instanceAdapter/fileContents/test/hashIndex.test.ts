import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

import { appendFile, link, mkdir, readdir, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fakeInstallationFileReader } from '../../../test/fakeInstallationFileReader';
import { fileProblemsFake } from '../../../test/fileProblemsFake';
import { adapterOver } from '../../../test/mo2/adapterOver';
import type { GamePlace, InstallationFileReader, InstanceAdapter } from '../../instanceAdapter';
import type { FileProblems } from '../../../ports/fileProblems';
import { expectKind } from '../../../test/expectKind';
import { composedOver, mo2InstanceHolding } from '../../test/mo2InstanceHolding';

const HASH_OF_AAAA = 'Mr+EvxoNp0I=';
const HASH_OF_BBBB = 'M5WSec/sW34=';
const HASH_OF_CCCC = 'rYontyeqpd8=';
const HASH_OF_ARCHIVE = '7R3YJUWF5oA=';
const ENTRIES = ['a.esp', 'textures/b.dds'];
const MOD_ENTRIES = [{ path: 'a.esp', hash: '+rJPuyOy4u8=' }, { path: 'textures/b.dds', hash: 'uXAXn9wLC0k=' }];
const LONG_AGO = new Date('2020-01-01T00:00:00Z');
const aMinuteAhead = (): Date => new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);

const holding = (reader: InstallationFileReader = fakeInstallationFileReader(ENTRIES)) => mo2InstanceHolding({}, { installationFileReader: reader });
const reopened = (root: string, reader: InstallationFileReader = fakeInstallationFileReader(ENTRIES)): InstanceAdapter =>
  adapterOver(root, { installationFileReader: reader });

const withProblems = (root: string, installationFileReader: InstallationFileReader, fileProblems: FileProblems): InstanceAdapter =>
  composedOver(root, { installationFileReader, fileProblems });

async function placed(path: string, body: string, at: Date = LONG_AGO): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  await utimes(path, at, at);
  return path;
}

const gamePlace = (root: string): GamePlace => ({ root, depots: [], depotProblems: [] });
const gameHash = async (adapter: InstanceAdapter, root: string, path: string): Promise<string | undefined> =>
  (await adapter.gameFiles(gamePlace(root), [path])).files[0]?.hash;

const indexText = (root: string): Promise<string> => readFile(join(root, 'hash-index', 'hashes.jsonl'), 'utf8').catch(() => '');

function counting(installationFileReader: InstallationFileReader): InstallationFileReader & { extracted: string[] } {
  const extracted: string[] = [];
  return { ...installationFileReader, extracted, extract: (path, dest) => { extracted.push(path); return installationFileReader.extract(path, dest); } };
}

function listing(installationFileReader: InstallationFileReader): InstallationFileReader & { listed: string[] } {
  const listed: string[] = [];
  return { ...installationFileReader, listed, list: (path) => { listed.push(path); return installationFileReader.list(path); } };
}

const refusing = (): InstallationFileReader => ({ ...fakeInstallationFileReader([]), list: () => Promise.reject(new Error('Can not open the file as archive')) });

describe('the sizes and hashes of the record index', () => {
  it('answers a game file\'s and an origin file\'s size and hash as mEdit\'s manifest carries it', async () => {
    const { root, adapter } = holding();
    await placed(join(root, 'Game', 'Game.esm'), 'aaaa');
    const origin = await placed(join(root, 'mods', 'M', 'Game.esm'), 'aaaa');

    expect([await adapter.gameFiles(gamePlace(join(root, 'Game')), ['Game.esm']), await adapter.originFileHash(origin)]).toEqual([
      { files: [{ root: join(root, 'Game'), path: 'Game.esm', hash: HASH_OF_AAAA }], unreadable: {} },
      { kind: 'read', answer: { size: 4, hash: HASH_OF_AAAA } },
    ]);
  });

  it('answers a downloaded file\'s size and hash and each entry\'s, extracting it in its folder and leaving only the record index there', async () => {
    const { root, adapter } = holding();
    const path = await placed(join(root, 'downloads', 'Mod.7z'), 'archive');

    expect(await adapter.downloadedFile('Mod.7z')).toEqual({ kind: 'read', answer: { path, size: 7, hash: HASH_OF_ARCHIVE, entries: MOD_ENTRIES } });
    expect(await readdir(join(root, 'hash-index'))).toEqual(['hashes.jsonl']);
  });

  it('keeps a downloaded file\'s hash, a game file\'s and an origin file\'s in the record index, so the next session reads none again', async () => {
    const { root, adapter } = holding();
    await placed(join(root, 'downloads', 'Mod.7z'), 'archive');
    await placed(join(root, 'Game', 'Game.esm'), 'aaaa');
    const copy = await placed(join(root, 'mods', 'M', 'copy.dds'), 'bbbb');
    await Promise.all([adapter.downloadedFile('Mod.7z'), gameHash(adapter, join(root, 'Game'), 'Game.esm'), adapter.originFileHash(copy)]);
    await placed(join(root, 'downloads', 'Mod.7z'), 'changed');
    await placed(join(root, 'Game', 'Game.esm'), 'cccc');
    await placed(copy, 'cccc');
    const reader = counting(fakeInstallationFileReader(ENTRIES));

    const next = reopened(root, reader);

    expect([
      expectKind(await next.downloadedFile('Mod.7z'), 'read').answer?.hash, await gameHash(next, join(root, 'Game'), 'Game.esm'), await next.originFileHash(copy), reader.extracted,
    ]).toEqual([HASH_OF_ARCHIVE, HASH_OF_AAAA, { kind: 'read', answer: { size: 4, hash: HASH_OF_BBBB } }, []]);
  });

  it('hashes a downloaded file\'s entries though its hash alone was asked before', async () => {
    const { root, adapter } = holding();
    await placed(join(root, 'downloads', 'Mod.7z'), 'archive');
    await gameHash(adapter, join(root, 'downloads'), 'Mod.7z');

    expect(await adapter.downloadedFile('Mod.7z')).toMatchObject({ kind: 'read', answer: { entries: ENTRIES.map((path) => ({ path })) } });
  });

  it('answers a file it cannot read, or a downloaded file the installation file reader cannot open, with the reason', async () => {
    const { root, adapter } = holding(refusing());
    await placed(join(root, 'downloads', 'Mod.esp'), 'aaaa');

    const missing = await adapter.originFileHash(join(root, 'mods', 'M', 'none.dds'));
    const notAnInstallationFile = await adapter.downloadedFile('Mod.esp');

    expect(missing).toEqual({ kind: 'unreadable', reason: expect.stringContaining('ENOENT') as unknown });
    expect(notAnInstallationFile).toEqual({ kind: 'unreadable', reason: 'Can not open the file as archive' });
    expect(await readdir(join(root, 'hash-index')).catch(() => [])).toEqual([]);
  });

  it('answers a downloaded file whose entries differ only by case unreadable, naming them, and extracts none of it', async () => {
    const reader = counting(fakeInstallationFileReader(['textures/a.dds', 'Textures/A.DDS', 'b.esp']));
    const { root, adapter } = holding(reader);
    await placed(join(root, 'downloads', 'Mod.7z'), 'archive');

    expect(await adapter.downloadedFile('Mod.7z')).toEqual({
      kind: 'unreadable',
      reason: 'Its entries textures/a.dds and Textures/A.DDS differ only by case, so one extracts over the other.',
    });
    expect(reader.extracted).toEqual([]);
  });

  it('reads no game file or downloaded file again whose stamp is unchanged, in this session or the next', async () => {
    const reader = counting(fakeInstallationFileReader(ENTRIES));
    const { root, adapter } = holding(reader);
    const game = join(root, 'Game');
    await placed(join(game, 'Game.esm'), 'aaaa');
    const downloadedFile = await placed(join(root, 'downloads', 'Mod.7z'), 'archive');
    const first = [await gameHash(adapter, game, 'Game.esm'), await adapter.downloadedFile('Mod.7z')];
    await placed(join(game, 'Game.esm'), 'bbbb');
    await placed(downloadedFile, 'changed');

    const next = reopened(root, reader);

    expect([await gameHash(adapter, game, 'Game.esm'), await gameHash(next, game, 'Game.esm'), await next.downloadedFile('Mod.7z')]).toEqual([first[0], ...first]);
    expect(reader.extracted).toEqual([downloadedFile]);
  });

  it('reads no file again that a deploy or a purge linked or unlinked', async () => {
    const { root, adapter } = holding();
    const file = await placed(join(root, 'Game', 'Game.esm'), 'aaaa');
    await gameHash(adapter, join(root, 'Game'), 'Game.esm');

    await link(file, join(root, 'Game', 'Linked.esm'));
    await unlink(join(root, 'Game', 'Linked.esm'));
    await placed(file, 'bbbb');

    expect(await gameHash(adapter, join(root, 'Game'), 'Game.esm')).toBe(HASH_OF_AAAA);
  });

  it('reads again, and keeps no record of, a file whose stamp is within a clock tick of its read, as a write in that tick may keep the stamp', async () => {
    const { root, adapter } = holding();
    const at = aMinuteAhead();
    const file = await placed(join(root, 'mods', 'M', 'a.dds'), 'aaaa', at);
    const first = await adapter.originFileHash(file);
    await placed(file, 'bbbb', at);
    const second = await adapter.originFileHash(file);
    await placed(file, 'cccc', at);

    const third = await reopened(root).originFileHash(file);

    expect([first, second, third]).toEqual([HASH_OF_AAAA, HASH_OF_BBBB, HASH_OF_CCCC].map((hash) => ({ kind: 'read', answer: { size: 4, hash } })));
  });

  it('reads a file once for two asks while its first read is still going', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reader = listing({ ...fakeInstallationFileReader(ENTRIES), list: async (path) => { await held; return fakeInstallationFileReader(ENTRIES).list(path); } });
    const { root, adapter } = holding(reader);
    const path = await placed(join(root, 'downloads', 'Mod.7z'), 'archive', aMinuteAhead());
    const stampsOf = (): number => vi.mocked(stat).mock.calls.filter(([of], at) => of === path && vi.mocked(stat).mock.settledResults[at]?.type === 'fulfilled').length;
    vi.mocked(stat).mockClear();

    const first = adapter.downloadedFile('Mod.7z');
    await vi.waitUntil(() => reader.listed.length === 1);
    const second = adapter.downloadedFile('Mod.7z');
    await vi.waitUntil(() => stampsOf() === 2);
    await new Promise(setImmediate);
    release();
    await Promise.all([first, second]);

    expect(reader.listed).toHaveLength(1);
  });

  it('skips a line of the record index it cannot read, as a crash mid-write leaves one, and trusts the lines it can', async () => {
    const { root, adapter } = holding();
    const file = await placed(join(root, 'Game', 'Game.esm'), 'aaaa');
    await gameHash(adapter, join(root, 'Game'), 'Game.esm');
    await appendFile(join(root, 'hash-index', 'hashes.jsonl'), '["game","/torn');
    await placed(file, 'bbbb');

    expect(await gameHash(reopened(root), join(root, 'Game'), 'Game.esm')).toBe(HASH_OF_AAAA);
  });

  it('removes the extractions a crash left in its folder when it opens, before it extracts anything', async () => {
    const installationFileReader = fakeInstallationFileReader(ENTRIES);
    const extractingInto: string[][] = [];
    const { root, adapter } = holding({
      ...installationFileReader,
      extract: async (path, dest) => { extractingInto.push(await readdir(join(root, 'hash-index'))); return installationFileReader.extract(path, dest); },
    });
    await placed(join(root, 'hash-index', 'entries-crashed', 'texture.dds'), 'aaaa');
    await placed(join(root, 'downloads', 'Mod.7z'), 'archive');

    await adapter.downloadedFile('Mod.7z');

    expect(extractingInto.flat()).not.toContain('entries-crashed');
    expect(await readdir(join(root, 'hash-index'))).not.toContain('entries-crashed');
  });

  it('extracts one downloaded file at a time, however many are asked at once', async () => {
    const installationFileReader = fakeInstallationFileReader(ENTRIES);
    let extracting = 0;
    let mostAtOnce = 0;
    const { root, adapter } = holding({
      ...installationFileReader,
      extract: async (path, dest) => {
        mostAtOnce = Math.max(mostAtOnce, ++extracting);
        await new Promise((resolve) => setImmediate(resolve));
        await installationFileReader.extract(path, dest);
        extracting--;
      },
    });
    await Promise.all(['A.7z', 'B.7z', 'C.7z'].map((name) => placed(join(root, 'downloads', name), 'archive')));

    await Promise.all(['A.7z', 'B.7z', 'C.7z'].map((name) => adapter.downloadedFile(name)));

    expect(mostAtOnce).toBe(1);
  });

  describe('every downloaded file asked', () => {
    const byPath = <T extends { readonly path: string }>(files: readonly T[]): T[] => [...files].sort((a, b) => a.path.localeCompare(b.path));

    it('answers each with its entries, hashing one at a time only those the index lacks, and hears how many are left before each', async () => {
      const { root, adapter } = holding();
      const [lackedFirst, lackedNext, held] = await Promise.all(['A.7z', 'B.7z', 'Held.7z'].map((name) => placed(join(root, 'downloads', name), 'archive')));
      await adapter.downloadedFile('Held.7z');
      const next = counting(fakeInstallationFileReader(ENTRIES));
      const left: number[] = [];

      const answer = await reopened(root, next).downloadedFilesHashed({ onHashing: (count) => left.push(count) });

      expect([byPath(answer.files), answer.notes]).toEqual([[lackedFirst, lackedNext, held].map((path) => ({ path, size: 7, hash: HASH_OF_ARCHIVE, entries: MOD_ENTRIES })), []]);
      expect([next.extracted.sort(), left]).toEqual([[lackedFirst, lackedNext], [2, 1]]);
    });

    it('keeps each hash it finished when its signal aborts part way, so the next ask hashes none of those again', async () => {
      const { root, adapter } = holding();
      const paths = await Promise.all(['A.7z', 'B.7z', 'C.7z'].map((name) => placed(join(root, 'downloads', name), 'archive')));
      const cancel = new AbortController();
      const [hashedFirst] = (await adapter.downloadedFilesHashed({ signal: cancel.signal, onHashing: () => { cancel.abort(); } })).files;
      const next = counting(fakeInstallationFileReader(ENTRIES));

      await reopened(root, next).downloadedFilesHashed();

      expect([...next.extracted, hashedFirst?.path].sort()).toEqual(paths);
    });

    it('hashes no file again that it could not hash while its stamp holds in this session, and a reload hashes it again', async () => {
      const reader = listing(refusing());
      const { root, adapter } = holding(reader);
      await placed(join(root, 'downloads', 'Corrupt.7z'), 'archive');
      await adapter.downloadedFilesHashed();

      await adapter.downloadedFilesHashed();
      const afterSecondAsk = reader.listed.length;
      await reopened(root, reader).downloadedFilesHashed();

      expect([afterSecondAsk, reader.listed.length, await indexText(root)]).toEqual([1, 2, '']);
    });

    it('asked for one downloaded file at a time, as the installation file read does, reads no file again that is unchanged or failed, nor extracts a missing one', async () => {
      const reader = listing({ ...fakeInstallationFileReader([]), list: () => Promise.reject(new Error('7z crashed')) });
      const { root, adapter } = holding(reader);
      const crashed = await placed(join(root, 'downloads', 'Crashes.rar'), 'archive');
      const first = [await adapter.downloadedFile('Crashes.rar'), await adapter.downloadedFile('Gone.7z')];

      const second = [await adapter.downloadedFile('Crashes.rar'), await adapter.downloadedFile('Gone.7z')];

      expect([second, reader.listed]).toEqual([first, [crashed]]);
    });

    it('shows a file it could not hash as a problem on that file, until it hashes or is gone', async () => {
      const { root } = holding();
      const file = await placed(join(root, 'downloads', 'Mod.7z'), 'archive');
      const folderAtAFile = join(root, 'mods', 'M', 'a.dds');
      await mkdir(folderAtAFile, { recursive: true });
      const problems = fileProblemsFake();
      await withProblems(root, refusing(), problems).downloadedFilesHashed();
      const whileBroken = new Map(problems.held);
      const fixed = withProblems(root, fakeInstallationFileReader(ENTRIES), problems);
      await fixed.downloadedFilesHashed();
      const afterFix = new Map(problems.held);
      await fixed.originFileHash(folderAtAFile);
      const whileUnreadable = [...problems.held.keys()];
      await rm(folderAtAFile, { recursive: true });
      await fixed.originFileHash(folderAtAFile);

      expect([whileBroken, afterFix, whileUnreadable, problems.held]).toEqual([
        new Map([[file, [{ line: 1, message: 'could not be hashed: Can not open the file as archive' }]]]), new Map(), [folderAtAFile], new Map(),
      ]);
    });

    it('says why the hash index could not be written, as the next run hashes those files again', async () => {
      const { root, adapter } = holding();
      await mkdir(join(root, 'hash-index', 'hashes.jsonl'), { recursive: true });
      const path = await placed(join(root, 'downloads', 'Mod.7z'), 'archive');

      const answer = await adapter.downloadedFilesHashed();

      expect(answer).toEqual({
        files: [{ path, size: 7, hash: HASH_OF_ARCHIVE, entries: MOD_ENTRIES }],
        notes: [expect.stringMatching(/^the hash index could not be written, so the next run hashes these files again: .*EISDIR/) as unknown],
      });
    });

    it('answers no file it could not read, and notes none of them', async () => {
      const { root } = holding();
      const file = await placed(join(root, 'downloads', 'Mod.7z'), 'archive');
      const fileProblems = fileProblemsFake();

      const answer = await withProblems(root, refusing(), fileProblems).downloadedFilesHashed();

      expect(answer).toEqual({ files: [], notes: [] });
      expect([...fileProblems.held.keys()]).toEqual([file]);
    });
  });
});
