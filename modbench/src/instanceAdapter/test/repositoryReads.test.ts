import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';
import { cloneCorpusFixture } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import { hostGitDisabled, hostGitHolding, hostGitHoldingNone, hostWithoutGit, type HeldRepository } from '../../test/hostGitDouble';
import type { HostGit } from '../../ports/repository';
import { CHECK_THE_DISK, type InstanceAdapter, type Reread } from '../instanceAdapter';
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

describe('the MO2 reading of an instance repository', () => {
  let instance: string;
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', instance, '-c', 'user.name=Modbench', '-c', 'user.email=modbench@example.com', ...args]);
  };
  const gitRunIn = async (adapter: InstanceAdapter, reread: Reread): Promise<string[]> => {
    spawns.mockClear();
    await adapter.reading(reread);
    return gitRuns();
  };
  const unrelated = (): Reread => ({ named: [join(instance, 'mods', 'Harder VATS', 'Harder VATS.esp')], disk: false });
  const PUSH_CHECK_READS = ['config --type=path --get core.hooksPath', 'rev-parse --git-common-dir', 'rev-parse --git-path hooks'];

  const setUpOver = async (host: HostGit<string>): Promise<InstanceAdapter> => {
    const adapter = adapterOver(instance, { hostGit: host });
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

    const heardOf = async (adapter: InstanceAdapter): Promise<string[]> => {
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

      expect([runs, held.configAsked.sort()]).toEqual([PUSH_CHECK_READS, ['filter.modbench-publisher-tokens.clean', 'filter.modbench-settings-tokens.clean', FILTER]]);
    });

    it('lists nothing again in the reading named the change VS Code\'s git says it made', async () => {
      const adapter = await setUpOver(held.host);
      const heard = await heardOf(adapter);
      vi.mocked(readdir).mockClear();

      await adapter.reading({ named: heard, disk: false });

      expect(vi.mocked(readdir).mock.calls.map(([folder]) => folder)).toEqual([]);
    });

    it('runs every git read again at a check of the disk', async () => {
      const adapter = await setUpOver(held.host);

      expect([await gitRunIn(adapter, CHECK_THE_DISK), await gitRunIn(adapter, CHECK_THE_DISK)]).toEqual([PUSH_CHECK_READS, PUSH_CHECK_READS]);
    });

    it('has VS Code\'s git run its status before it answers HEAD at a check of the disk, and only then', async () => {
      const adapter = await setUpOver(held.host);
      const before = held.statusRuns();
      await adapter.reading(unrelated());
      const unrelatedRuns = held.statusRuns() - before;

      await adapter.reading(CHECK_THE_DISK);

      expect([unrelatedRuns, held.statusRuns() - before]).toEqual([0, 1]);
    });

    it.each([
      ['the change VS Code\'s git says it made', async (adapter: InstanceAdapter) => heardOf(adapter), 0],
      ['the .git a write of Modbench\'s wrote', () => Promise.resolve([join(instance, '.git')]), 1],
      ['a write to the index, as the watch names it', () => Promise.resolve([join(instance, '.git', 'index')]), 0],
    ])('has VS Code\'s git run its status, or not, in a reading named %s', async (_named, named, runs) => {
      const adapter = await setUpOver(held.host);
      const paths = await named(adapter);
      const before = held.statusRuns();

      await adapter.reading({ named: paths, disk: false });

      expect(held.statusRuns() - before).toBe(runs);
    });

    it('tells nothing of the status it has VS Code\'s git run, though VS Code\'s git told of a change before it', async () => {
      const adapter = await setUpOver(held.host);
      const heard: (string | undefined)[] = [];
      const subscription = adapter.subscribe((path) => { heard.push(path); });
      held.changed();
      heard.length = 0;
      const before = held.statusRuns();

      await adapter.reading({ named: [join(instance, '.git')], disk: false });
      subscription.dispose();

      expect([held.statusRuns() - before, heard]).toEqual([1, []]);
    });

    it('asks again for an answer whose ask failed', async () => {
      const adapter = await setUpOver(held.host);
      held.configAsked.length = 0;
      held.failNextConfig();
      await adapter.reading(CHECK_THE_DISK).catch(() => undefined);
      const failed = held.configAsked[0];
      held.configAsked.length = 0;

      await adapter.reading(unrelated());

      expect(held.configAsked).toEqual([failed]);
    });

    it('reads its filter as VS Code\'s git answers the repository\'s own config', async () => {
      const adapter = await setUpOver(held.host);

      expect((await adapter.reading(CHECK_THE_DISK)).repositorySetUp).toBe(false);
    });
  });

  describe('that VS Code\'s git opens or closes while Modbench listens', () => {
    const listening = async (held: HeldRepository): Promise<{ adapter: InstanceAdapter; heard: (string | undefined)[] }> => {
      const adapter = await setUpOver(held.host);
      const heard: (string | undefined)[] = [];
      adapter.subscribe((path) => { heard.push(path); });
      await adapter.reading();
      heard.length = 0;
      return { adapter, heard };
    };

    it('follows the instance\'s repository VS Code\'s git opens once Modbench listens', async () => {
      const held = hostGitHolding(instance, { open: false });
      const { heard } = await listening(held);

      held.open();
      held.changed();

      expect(heard).toEqual([join(instance, '.git', 'HEAD'), join(instance, '.git', 'HEAD')]);
    });

    it('hears nothing of a repository VS Code\'s git opens elsewhere', async () => {
      const held = hostGitHolding(instance);
      const { heard } = await listening(held);

      held.openElsewhere(join(instance, 'source', 'Harder VATS'));

      expect(heard).toEqual([]);
    });

    it('hears VS Code\'s git close the repository, and runs git for each read after', async () => {
      const held = hostGitHolding(instance);
      const { adapter, heard } = await listening(held);

      held.close();

      expect([heard.length, await gitRunIn(adapter, { named: heard.map(String), disk: false })]).toEqual([1, expect.arrayContaining([
        'config --local --get filter.modbench-publisher-tokens.clean', 'config --local --get filter.modbench-settings-tokens.clean', `config --local --get ${FILTER}`,
        'rev-parse -q --verify HEAD',
      ]) as unknown]);
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
      'config --local --get filter.modbench-publisher-tokens.clean', 'config --local --get filter.modbench-settings-tokens.clean', `config --local --get ${FILTER}`,
      'config --type=path --get core.hooksPath',
      'rev-parse --git-common-dir', 'rev-parse --git-path hooks', 'rev-parse -q --verify HEAD',
    ];

    expect(await gitRunIn(adapter, dotGit())).toEqual(ALL_READS);
  });
});
