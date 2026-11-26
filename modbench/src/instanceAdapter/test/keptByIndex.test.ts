import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECK_THE_DISK, type InstanceAdapter, type Reread } from '../instanceAdapter';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceOnDisk } from './instanceOnDisk';

const listings = vi.hoisted(() => ({ asked: [] as string[], failNext: false }));

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = promisify(actual.execFile);
  const asked = (file: string, args: readonly string[], options: object) => {
    const listing = file === 'git' && args.includes('ls-files');
    if (listing) listings.asked.push(String(args[1]));
    if (listing && listings.failNext) {
      listings.failNext = false;
      return Promise.reject(new Error('git failed'));
    }
    return run(file, args, options);
  };
  return { ...actual, execFile: Object.assign(actual.execFile.bind(undefined), { [promisify.custom]: asked }) };
});

const HOUR_MS = 3_600_000;
const git = (folder: string, ...args: string[]): string =>
  execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

let laterEachTimeMs = 0;
const modifiedLater = async (path: string): Promise<void> => {
  laterEachTimeMs += 10_000;
  const later = new Date((await stat(path)).mtimeMs + laterEachTimeMs);
  await utimes(path, later, later);
};

describe('whether the instance repository tracks a source folder, git\'s answer kept while its index and .gitmodules keep their stamps', () => {
  let root: string;
  let adapter: InstanceAdapter;

  const sourceFolder = async (repository: string, name: string): Promise<void> => {
    await mkdir(join(repository, 'source', name), { recursive: true });
    await writeFile(join(repository, 'source', name, 'build.json'), '{}');
  };
  const tracking = (repository: string, name: string): void => { git(repository, 'add', '--', `source/${name}/build.json`); };

  beforeEach(async () => {
    root = await instanceOnDisk();
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', 'ModOrganizer.ini', 'profiles');
    git(root, 'commit', '-q', '-m', 'one');
    await Promise.all([sourceFolder(root, 'X'), sourceFolder(root, 'Y')]);
    tracking(root, 'X');
    adapter = adapterOver(root);
    listings.asked = [];
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
  });

  afterEach(async () => {
    vi.useRealTimers();
    listings.failNext = false;
    await rm(root, { recursive: true, force: true });
  });

  it('reads once while neither file has changed', async () => {
    const answers = [await adapter.sourceFolderTracked('X'), await adapter.sourceFolderTracked('X')];

    expect([answers, listings.asked]).toEqual([[true, true], [root]]);
  });

  it('keeps each key\'s answer apart', async () => {
    const answers = [await adapter.sourceFolderTracked('X'), await adapter.sourceFolderTracked('Y')];

    expect([answers, listings.asked]).toEqual([[true, false], [root, root]]);
  });

  it('reads again once the index has changed', async () => {
    const before = await adapter.sourceFolderTracked('Y');
    tracking(root, 'Y');
    await modifiedLater(join(root, '.git', 'index'));

    expect([before, await adapter.sourceFolderTracked('Y')]).toEqual([false, true]);
  });

  it('reads again once .gitmodules appears, and once it changes', async () => {
    await adapter.sourceFolderTracked('X');
    await writeFile(join(root, '.gitmodules'), '');
    await adapter.sourceFolderTracked('X');
    await modifiedLater(join(root, '.gitmodules'));
    await adapter.sourceFolderTracked('X');

    expect(listings.asked).toEqual([root, root, root]);
  });

  describe('of an instance that is a linked worktree', () => {
    let linked: string;
    beforeEach(async () => {
      linked = `${root}-linked`;
      git(root, 'add', '--', 'source');
      git(root, 'commit', '-q', '-m', 'sources');
      git(root, 'worktree', 'add', '-q', '-b', 'side', linked);
      await mkdir(join(linked, 'mods'));
      git(linked, 'rm', '-q', '--cached', '--', 'source/Y/build.json');
      listings.asked = [];
    });
    afterEach(() => rm(linked, { recursive: true, force: true }));

    it('follows the index of a linked worktree, which is in the git directory its .git file names', async () => {
      const onLinked = adapterOver(linked);
      const before = await onLinked.sourceFolderTracked('Y');
      tracking(linked, 'Y');
      await modifiedLater(join(git(linked, 'rev-parse', '--absolute-git-dir').trim(), 'index'));

      expect([before, await onLinked.sourceFolderTracked('Y')]).toEqual([false, true]);
    });

    it('trusts within a reading the index a change named, and stamps afresh a linked worktree\'s, which no watch follows', async () => {
      const [onRoot, onLinked] = [adapterOver(root), adapterOver(linked)];
      git(root, 'rm', '-q', '--cached', '--', 'source/Y/build.json');
      const inReading = async (adapterOf: InstanceAdapter, reread: Reread): Promise<boolean> =>
        (await adapterOf.reading(reread)).trustingKept(() => adapterOf.sourceFolderTracked('Y'));
      await Promise.all([inReading(onRoot, CHECK_THE_DISK), inReading(onLinked, CHECK_THE_DISK)]);
      tracking(root, 'Y');
      tracking(linked, 'Y');
      await modifiedLater(join(root, '.git', 'index'));
      await modifiedLater(join(git(linked, 'rev-parse', '--absolute-git-dir').trim(), 'index'));

      expect([await inReading(onRoot, { named: [], disk: false }), await inReading(onLinked, { named: [], disk: false })]).toEqual([false, true]);
    });
  });

  it('keeps no answer whose read rejected', async () => {
    listings.failNext = true;
    await expect(adapter.sourceFolderTracked('X')).rejects.toThrow('git failed');

    expect([await adapter.sourceFolderTracked('X'), listings.asked]).toEqual([true, [root, root]]);
  });
});
