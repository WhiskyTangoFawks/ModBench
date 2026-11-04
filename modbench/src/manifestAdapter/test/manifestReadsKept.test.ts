import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestAt, manifestIn, type Manifest } from '../manifestAdapter';
import { manifestText } from '../manifestText';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});

const HOUR_MS = 3_600_000;
const manifestOf = (hash: string): Manifest => ({ packages: [], exclude: [], ignore: [], flags: new Map(), files: new Map([['a.nif', hash]]) });
const callsOn = (spy: typeof readdir | typeof readFile, path: string): number => vi.mocked(spy).mock.calls.filter(([called]) => called === path).length;

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('a folder\'s manifest read by the stamps of its folder and its file', () => {
  let root: string;
  let folder: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'manifestReadsKept-'));
    folder = join(root, 'Mod');
    file = join(folder, 'Mod.manifest.json');
    await mkdir(folder);
    await writeFile(file, manifestText(manifestOf('AAAAAAAAAAA=')));
    vi.mocked(readdir).mockClear();
    vi.mocked(readFile).mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  const settle = (): void => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  };

  it('lists the folder and reads the file once while neither stamp has changed', async () => {
    settle();
    await manifestIn(folder);
    await manifestAt(folder);

    expect({ listings: callsOn(readdir, folder), reads: callsOn(readFile, file) }).toEqual({ listings: 1, reads: 1 });
  });

  it('shows the manifest a file holds once its stamp changes', async () => {
    settle();
    await manifestIn(folder);
    await writeFile(file, manifestText(manifestOf('BBBBBBBBBBA=')));
    await modifiedLater(file);

    expect(await manifestIn(folder)).toEqual({ manifest: manifestOf('BBBBBBBBBBA=') });
  });

  it('shows a second manifest once the folder\'s stamp changes', async () => {
    settle();
    await manifestIn(folder);
    await writeFile(join(folder, 'Other.manifest.json'), manifestText(manifestOf('AAAAAAAAAAA=')));
    await modifiedLater(folder);

    expect(await manifestIn(folder)).toEqual({ refused: "its folder holds two manifests, 'Mod.manifest.json' and 'Other.manifest.json'" });
  });

  it('reads a folder that is not there as holding no manifest', async () => {
    expect(await manifestIn(join(root, 'Gone'))).toBeUndefined();
  });
});
