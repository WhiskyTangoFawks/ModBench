import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { managerOver } from '../../test/mo2/adapterOver';
import { hostGitDisabled, hostGitHolding, hostGitHoldingNone, hostWithoutGit, type HeldRepository } from '../../test/hostGitDouble';
import type { HostGit } from '../../ports/repository';
import { readTrustingKept } from '../files';
import { CHECK_THE_DISK, type Reread } from '../instanceAdapter';
import { repositoryReads, type RepositoryReads } from '../repositoryReads';
const spawns = vi.hoisted(() => vi.fn<(file: string, args: string[], options: unknown) => Promise<unknown>>());
vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  spawns.mockImplementation(promisify(actual.execFile));
  return { ...actual, execFile: Object.assign(vi.fn(actual.execFile), { [promisify.custom]: spawns }) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const HOUR_MS = 3_600_000;
const FILTER = 'filter.modbench-tokens.clean';
const gitRuns = (): string[] => spawns.mock.calls.flatMap(([file, args]) => (file === 'git' ? [args.slice(2).join(' ')] : [])).sort();

describe('the instance repository\'s reads', () => {
  let folder: string;
  const hearing = (reads: RepositoryReads): string[] => {
    const heard: string[] = [];
    reads.changed((path) => { heard.push(path); });
    return heard;
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'modbench-repository-reads-'));
    execFileSync('git', ['init', '-q', folder]);
    spawns.mockClear();
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('answers HEAD and the repository\'s own config from VS Code\'s git, running no git', async () => {
    const held = hostGitHolding(folder, { head: 'abc123' });
    held.config.set(FILTER, 'clean');
    const reads = repositoryReads(folder, held.host);

    expect([await reads.head(), await reads.localConfig(FILTER), gitRuns()]).toEqual(['abc123', 'clean', []]);
  });

  it('has VS Code\'s git run its status before it answers HEAD at a check of the disk, and only then', async () => {
    const held = hostGitHolding(folder, { head: 'one' });
    const reads = repositoryReads(folder, held.host);
    const headIn = async (disk: boolean): Promise<[string | undefined, number]> => [(await readTrustingKept([], disk, reads.head)).answer, held.statusRuns()];
    await headIn(true);
    held.head = 'two';

    expect([await headIn(false), await headIn(true)]).toEqual([['one', 1], ['two', 2]]);
  });

  it('runs no status of its own in a reading named the change VS Code\'s git says it made', async () => {
    const held = hostGitHolding(folder, { head: 'one' });
    const reads = repositoryReads(folder, held.host);
    const heard = hearing(reads);
    await readTrustingKept([], true, reads.head);
    held.head = 'two';
    held.changed();

    expect([(await readTrustingKept(heard, false, reads.head)).answer, held.statusRuns()]).toEqual(['two', 2]);
  });

  it('has VS Code\'s git run its status in a reading that names the .git a write of Modbench\'s wrote, and tells nothing of that run', async () => {
    const held = hostGitHolding(folder, { head: 'one' });
    const reads = repositoryReads(folder, held.host);
    const heard = hearing(reads);
    await readTrustingKept([], true, reads.head);
    held.head = 'two';

    const read = await readTrustingKept([join(folder, '.git')], false, reads.head);

    expect([read.answer, held.statusRuns(), heard]).toEqual(['two', 2, []]);
  });

  it('follows the instance\'s repository VS Code\'s git opens once Modbench listens', async () => {
    const held = hostGitHolding(folder, { open: false });
    const reads = repositoryReads(folder, held.host);
    const heard = hearing(reads);
    await reads.localConfig(FILTER);
    held.open();
    held.changed();

    expect(heard).toEqual([join(folder, '.git'), join(folder, '.git')]);
  });

  it('hears nothing of a repository VS Code\'s git opens elsewhere', async () => {
    const held = hostGitHolding(folder);
    const reads = repositoryReads(folder, held.host);
    const heard = hearing(reads);
    await reads.localConfig(FILTER);
    held.openElsewhere(join(folder, 'source', 'Harder VATS'));

    expect(heard).toEqual([]);
  });

  it('hears VS Code\'s git close the repository, and runs git for each read after', async () => {
    const held = hostGitHolding(folder);
    const reads = repositoryReads(folder, held.host);
    const heard = hearing(reads);
    await readTrustingKept([], true, () => reads.localConfig(FILTER));
    held.close();
    spawns.mockClear();

    await readTrustingKept(heard, false, () => reads.localConfig(FILTER));

    expect([heard.length, gitRuns()]).toEqual([1, [`config --local --get ${FILTER}`]]);
  });

  it('asks again for an answer whose ask failed', async () => {
    const held = hostGitHolding(folder);
    const reads = repositoryReads(folder, held.host);
    held.failNextConfig();
    const failed = await readTrustingKept([], true, () => reads.localConfig(FILTER)).catch((err: unknown) => String(err));

    const again = await readTrustingKept([], false, () => reads.localConfig(FILTER));

    expect([failed, again.answer, held.configAsked]).toEqual(['Error: spawn git EAGAIN', '', [FILTER, FILTER]]);
  });
});

describe('the MO2 reading of an instance repository', () => {
  let instance: string;
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', instance, '-c', 'user.name=Modbench', '-c', 'user.email=modbench@example.com', ...args]);
  };
  const gitRunIn = async (adapter: ReturnType<typeof managerOver>, reread: Reread): Promise<string[]> => {
    spawns.mockClear();
    await adapter.reading(reread);
    return gitRuns();
  };
  const unrelated = (): Reread => ({ named: [join(instance, 'mods', 'Harder VATS', 'Harder VATS.esp')], disk: false });
  const PUSH_CHECK_READS = ['config --type=path --get core.hooksPath', 'rev-parse --git-common-dir', 'rev-parse --git-path hooks'];

  const setUpOver = async (host: HostGit<string>): Promise<ReturnType<typeof managerOver>> => {
    const adapter = managerOver(instance, { hostGit: host });
    await adapter.refuseUnpublishedPins();
    await adapter.writePathTokens();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + HOUR_MS });
    await adapter.reading(CHECK_THE_DISK);
    return adapter;
  };

  beforeEach(() => {
    instance = cloneCorpusFixture();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'One');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(instance, { recursive: true, force: true });
  });

  describe('that VS Code\'s git holds', () => {
    let held: HeldRepository;

    beforeEach(() => {
      held = hostGitHolding(instance);
    });

    it('runs no git in a reading named a file that is no change of the repository', async () => {
      const adapter = await setUpOver(held.host);

      expect(await gitRunIn(adapter, unrelated())).toEqual([]);
    });

    const heardOf = async (adapter: ReturnType<typeof managerOver>): Promise<string[]> => {
      const heard: string[] = [];
      const subscription = adapter.subscribe((path) => { heard.push(String(path)); });
      await vi.waitFor(() => { held.changed(); expect(heard).not.toEqual([]); });
      subscription.dispose();
      return heard;
    };

    it('reads the repository again in the reading named the change VS Code\'s git says it made', async () => {
      const adapter = await setUpOver(held.host);
      const heard = await heardOf(adapter);
      held.configAsked.length = 0;

      const runs = await gitRunIn(adapter, { named: heard, disk: false });

      expect([runs, held.configAsked.sort()]).toEqual([PUSH_CHECK_READS, ['filter.modbench-settings-tokens.clean', FILTER]]);
    });

    it('lists only the instance root again in the reading named the change VS Code\'s git says it made', async () => {
      const adapter = await setUpOver(held.host);
      const heard = await heardOf(adapter);
      vi.mocked(readdir).mockClear();

      await adapter.reading({ named: heard, disk: false });

      expect(vi.mocked(readdir).mock.calls.map(([folder]) => folder)).toEqual([instance, instance]);
    });

    it('runs every git read again at a check of the disk', async () => {
      const adapter = await setUpOver(held.host);

      expect([await gitRunIn(adapter, CHECK_THE_DISK), await gitRunIn(adapter, CHECK_THE_DISK)]).toEqual([PUSH_CHECK_READS, PUSH_CHECK_READS]);
    });

    it('reads its filter as VS Code\'s git answers the repository\'s own config', async () => {
      const adapter = await setUpOver(held.host);

      expect((await adapter.reading(CHECK_THE_DISK)).repositorySetUp).toBe(false);
    });
  });

  it.each<[string, () => HostGit<string>]>([
    ['without VS Code\'s git', () => hostWithoutGit],
    ['with git disabled', () => hostGitDisabled],
    ['with VS Code\'s git holding no repository', () => hostGitHoldingNone],
    ['with VS Code\'s git holding only a repository the instance is inside', () => hostGitHolding(dirname(instance)).host],
  ])('reads git again in a reading that names the repository\'s .git, %s', async (_case, host) => {
    const adapter = await setUpOver(host());
    const dotGit = (): Reread => ({ named: [join(instance, '.git', 'config')], disk: false });
    const ALL_READS = [
      'config --local --get filter.modbench-settings-tokens.clean', `config --local --get ${FILTER}`, 'config --type=path --get core.hooksPath',
      'rev-parse --git-common-dir', 'rev-parse --git-path hooks', 'rev-parse -q --verify HEAD',
    ];

    expect(await gitRunIn(adapter, dotGit())).toEqual(ALL_READS);
  });
});
