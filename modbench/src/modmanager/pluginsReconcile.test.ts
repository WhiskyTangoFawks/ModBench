import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginLinesDelta, reconcilePluginsWithDisk } from './pluginsReconcile';
import { Mo2ModlistSource } from './mo2/Mo2ModlistSource';
import { buildFileConflictIndex } from './fileConflictIndex';

const provided = (...names: string[]) => new Map(names.map((n) => [n.toLowerCase(), n] as const));
const folded = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));

describe('pluginLinesDelta — what plugins.txt must gain and lose to match disk (#680)', () => {
  it('appends every provided plugin with no line, ascending case-folded, and prunes nothing when all lines are provided', () => {
    const delta = pluginLinesDelta(['A.esp'], provided('A.esp', 'zeta.esp', 'Beta.esl'), folded());
    expect(delta).toEqual({ append: ['Beta.esl', 'zeta.esp'], prune: [] });
  });

  it('a line differing only in case from the on-disk name is the same plugin: neither appended nor pruned', () => {
    const delta = pluginLinesDelta(['BASE.esp'], provided('Base.esp'), folded());
    expect(delta).toEqual({ append: [], prune: [] });
  });

  it('prunes a line whose plugin no enabled mod, overwrite/, nor Data provides', () => {
    const delta = pluginLinesDelta(['Gone.esp', 'Kept.esp'], provided('Kept.esp'), folded());
    expect(delta).toEqual({ append: [], prune: ['Gone.esp'] });
  });

  it('keeps a line whose plugin lives in the game Data folder (DLC, Creation Club) even though no mod provides it', () => {
    const delta = pluginLinesDelta(['ccBGSFO4001-PipBoy(Black).esl'], provided(), folded('ccbgsfo4001-pipboy(black).esl'));
    expect(delta).toEqual({ append: [], prune: [] });
  });

  it('never appends from Data: a Data-folder plugin with no line stays unlisted', () => {
    const delta = pluginLinesDelta([], provided(), folded('DLCCoast.esm'));
    expect(delta).toEqual({ append: [], prune: [] });
  });

  it('with Data unknown, prunes nothing but still appends', () => {
    const delta = pluginLinesDelta(['Gone.esp'], provided('New.esp'), undefined);
    expect(delta).toEqual({ append: ['New.esp'], prune: [] });
  });
});

describe('reconcilePluginsWithDisk — plugins.txt converges on what disk provides (#680)', () => {
  let dir: string;
  let channel: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  const pluginsPath = () => join(dir, 'profiles', 'Default', 'plugins.txt');
  const plugins = () => readFile(pluginsPath(), 'utf8');
  // `null` = the game directory is unresolved (an explicit `undefined` would just select the default).
  const run = (dataFolder: string | null = join(dir, 'Game', 'Data'), buildIndex = buildFileConflictIndex) =>
    reconcilePluginsWithDisk({
      source: new Mo2ModlistSource(dir),
      instanceRoot: dir,
      dataFolder: () => Promise.resolve(dataFolder ?? undefined),
      buildIndex: (entries, root) => buildIndex(entries, root, () => {}),
      channel,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-reconcile-'));
    channel = { info: vi.fn(), error: vi.fn() };
    await mkdir(join(dir, 'mods', 'Provider'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Dormant'), { recursive: true });
    await mkdir(join(dir, 'profiles', 'Default'), { recursive: true });
    await mkdir(join(dir, 'Game', 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\n');
    await writeFile(join(dir, 'profiles', 'Default', 'modlist.txt'), '+Provider\r\n-Dormant\r\n');
    await writeFile(join(dir, 'mods', 'Provider', 'Base.esp'), 'plugin');
    await writeFile(join(dir, 'profiles', 'Default', 'plugins.txt'), '# header\r\n*Base.esp\r\n');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends a disabled line for every plugin an enabled mod or overwrite/ provides with no line — not for a disabled mod, not for a nested file', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'zeta.esp'), 'plugin');
    await writeFile(join(dir, 'mods', 'Provider', 'Alpha.esl'), 'plugin');
    await writeFile(join(dir, 'mods', 'Provider', 'readme.txt'), 'not a plugin');
    await mkdir(join(dir, 'mods', 'Provider', 'Nested'));
    await writeFile(join(dir, 'mods', 'Provider', 'Nested', 'Deep.esp'), 'plugin');
    await writeFile(join(dir, 'mods', 'Dormant', 'Sleeping.esp'), 'plugin');
    await mkdir(join(dir, 'overwrite'));
    await writeFile(join(dir, 'overwrite', 'FromCK.esp'), 'plugin');

    await run();

    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nAlpha.esl\r\nFromCK.esp\r\nzeta.esp\r\n');
    expect(channel.info).toHaveBeenCalledWith(expect.stringMatching(/Alpha\.esl.*FromCK\.esp.*zeta\.esp/));
    expect(channel.error).not.toHaveBeenCalled();
  });

  it('prunes a line whose plugin nothing provides, and keeps one the game Data folder provides', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n*DLCCoast.esm\r\n');

    await run();

    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
    expect(channel.info).toHaveBeenCalledWith(expect.stringContaining('Gone.esp'));
  });

  it('a plugin hidden the MO2 way (.mohidden suffix) is not present: never appended, and its line is pruned', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Hidden.esp.mohidden'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\nHidden.esp\r\n');

    await run();

    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('with the game directory unresolved, still appends but prunes nothing', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');

    await run(null);

    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\nNew.esp\r\n');
  });

  it('a failure to enumerate disk aborts the whole reconcile: nothing written, error logged, never thrown', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    await expect(run(null, () => Promise.reject(new Error('EACCES: walk failed')))).resolves.toBeUndefined();

    expect((await stat(pluginsPath())).mtime).toEqual(old);
    expect(channel.error).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('when the file already matches disk, nothing is written and nothing is logged', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    await run();

    expect((await stat(pluginsPath())).mtime).toEqual(old);
    expect(channel.info).not.toHaveBeenCalled();
  });
});
