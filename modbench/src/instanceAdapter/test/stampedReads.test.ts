import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { managerOver } from '../../test/mo2/adapterOver';
import { listDir, listDirByStamp, parsedBy } from '../files';
import { sortingRuleFilePaths } from '../mo2/layout';

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

const HOUR_MS = 3_600_000;
const listingsOf = (folder: string): number => vi.mocked(readdir).mock.calls.filter(([path]) => path === folder).length;
const modifiedLater = async (path: string): Promise<void> => {
  const later = new Date((await stat(path)).mtimeMs + 10_000);
  await utimes(path, later, later);
};
const namesOf = async (folder: string, list = listDirByStamp): Promise<string[]> => (await list(folder)).map((entry) => entry.name).sort();

describe('a folder listed and a file parsed by their stamps', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'medit-stamped-'));
    vi.mocked(readdir).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };

  it('lists a folder whose stamp has not changed once', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root);
    await namesOf(root);
    expect(listingsOf(root)).toBe(1);
  });

  it('lists a folder again, and shows its new entry, once its stamp changes', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root);
    await writeFile(join(root, 'b.esp'), '');
    await modifiedLater(root);
    expect(await namesOf(root)).toEqual(['a.esp', 'b.esp']);
    expect(listingsOf(root)).toBe(2);
  });

  it('lists a folder stamped within the last moments every time, as its stamp may not change for a write that follows', async () => {
    await writeFile(join(root, 'a.esp'), '');
    await namesOf(root);
    await namesOf(root);
    expect(listingsOf(root)).toBe(2);
  });

  it('lists a folder every time when a writer lists it, so a temp folder is never kept', async () => {
    await writeFile(join(root, 'a.esp'), '');
    settle();
    await namesOf(root, listDir);
    await namesOf(root, listDir);
    expect(listingsOf(root)).toBe(2);
  });

  it('parses a file whose stamp has not changed once', async () => {
    const path = join(root, 'meta.ini');
    await writeFile(path, 'one');
    settle();
    const parse = vi.fn((text: string) => text.length);
    const parsedAt = parsedBy(parse);
    await parsedAt(path);
    await parsedAt(path);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('parses a file again, and answers its new content, once its stamp changes', async () => {
    const path = join(root, 'meta.ini');
    await writeFile(path, 'one');
    settle();
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await writeFile(path, 'three');
    await modifiedLater(path);
    expect(await textAt(path)).toBe('three');
  });

  it('rejects for a file that is gone, as a read of it does', async () => {
    const path = join(root, 'meta.ini');
    await writeFile(path, 'one');
    settle();
    const textAt = parsedBy((text) => text);
    await textAt(path);
    await rm(path);
    await expect(textAt(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the MO2 reading of an instance nothing changed in', () => {
  let instance: string;

  beforeEach(() => {
    instance = cloneCorpusFixture();
    vi.mocked(readdir).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(instance, { recursive: true, force: true });
  });

  it('lists no mod folder again, and still shows a file added to one', async () => {
    const adapter = managerOver(instance);
    const first = await adapter.reading();
    const [name, files] = [...first.modFiles].find(([, listed]) => listed.files.length > 0) ?? ['', undefined];
    const folder = files?.folder ?? '';
    expect(name).not.toBe('');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading();
    vi.mocked(readdir).mockClear();
    await adapter.reading();
    expect(listingsOf(folder)).toBe(0);

    await mkdir(join(folder, 'added'), { recursive: true });
    await writeFile(join(folder, 'added', 'new.txt'), '');
    await modifiedLater(folder);
    const after = await adapter.reading();
    expect(after.modFiles.get(name)?.files.map((file) => file.relativePath)).toContain('added/new.txt');
  });
});

describe('the files an MO2 reading parses', () => {
  const readsOf = (suffix: string): number => vi.mocked(readFile).mock.calls.filter(([path]) => typeof path === 'string' && path.endsWith(suffix)).length;

  it.each(['.7z.meta', 'Patch Mod/meta.ini', 'Default/modlist.txt', 'Default/plugins.txt'])('reads %s again only once its stamp changes', async (suffix) => {
    const instance = cloneCorpusFixture();
    try {
      const adapter = managerOver(instance);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
      await adapter.reading();
      vi.mocked(readFile).mockClear();
      await adapter.reading();
      expect(readsOf(suffix)).toBe(0);
    } finally {
      vi.useRealTimers();
      await rm(instance, { recursive: true, force: true });
    }
  });

  it('reads a sorting rule file again only once its stamp changes', async () => {
    const instance = cloneCorpusFixture();
    try {
      const { masterlist } = sortingRuleFilePaths(instance);
      await writeFile(masterlist, 'plugins: []');
      const adapter = managerOver(instance);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
      await adapter.reading();
      vi.mocked(readFile).mockClear();
      await adapter.reading();
      expect(readsOf('masterlist.yaml')).toBe(0);
    } finally {
      vi.useRealTimers();
      await rm(instance, { recursive: true, force: true });
    }
  });
});
