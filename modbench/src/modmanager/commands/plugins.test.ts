import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPlugin, pluginLinesDelta, reconcilePlugins, reorderPlugins, setPluginEnabled } from './plugins';
import { buildTes4Buffer } from '../test/buildTes4Buffer';

const PROFILE = 'Default';
const INITIAL = '# header\r\n*Base.esp\r\nOther.esp\r\n';
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

describe('plugins.txt commands — each verb writes bytes or returns a refusal', () => {
  let dir: string;
  const pluginsPath = () => join(dir, 'profiles', PROFILE, 'plugins.txt');
  const plugins = () => readFile(pluginsPath(), 'utf8');
  const mtime = async () => (await stat(pluginsPath())).mtime;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-commands-'));
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await writeFile(pluginsPath(), INITIAL);
    await utimes(pluginsPath(), LONG_AGO, LONG_AGO);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('setPluginEnabled(false) drops only the target marker and leaves every other byte', async () => {
    expect(await setPluginEnabled(dir, PROFILE, 'Base.esp', false)).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nBase.esp\r\nOther.esp\r\n');
  });

  it('setPluginEnabled to the state the line already has writes nothing', async () => {
    expect(await setPluginEnabled(dir, PROFILE, 'Base.esp', true)).toEqual({ applied: true, wrote: false });
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setPluginEnabled refuses a name with no line, naming it, and writes nothing', async () => {
    expect(await setPluginEnabled(dir, PROFILE, 'No Such.esp', false)).toEqual({
      applied: false, refusal: expect.stringContaining('No Such.esp'),
    });
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('reorderPlugins writes the moved line at the requested slot', async () => {
    expect(await reorderPlugins(dir, PROFILE, ['Other.esp'], 0)).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nOther.esp\r\n*Base.esp\r\n');
  });

  it('reorderPlugins refuses a name with no line, naming it, and writes nothing', async () => {
    expect(await reorderPlugins(dir, PROFILE, ['No Such.esp'], 0)).toEqual({
      applied: false, refusal: expect.stringContaining('No Such.esp'),
    });
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('appendPlugin writes an enabled line at the winning end', async () => {
    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nOther.esp\r\n*New.esp\r\n');
  });

  it('appendPlugin refuses a name that already has a line, and writes nothing', async () => {
    expect(await appendPlugin(dir, PROFILE, 'Base.esp')).toEqual({
      applied: false, refusal: expect.stringContaining('Base.esp'),
    });
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('a profile with no plugins.txt refuses rather than creating one', async () => {
    const result = await setPluginEnabled(dir, 'NoSuchProfile', 'Base.esp', false);
    expect(result).toEqual({ applied: false, refusal: expect.stringContaining('ENOENT') });
  });

  // Rival this catches: a plain read-then-write per command. Both read the same text, and the
  // second write lands on top of the first, losing it.
  it('two gestures fired without awaiting the first both survive: neither read-modify-write is lost', async () => {
    const [first, second] = await Promise.all([
      setPluginEnabled(dir, PROFILE, 'Base.esp', false),
      appendPlugin(dir, PROFILE, 'New.esp'),
    ]);

    expect([first, second]).toEqual([{ applied: true, wrote: true }, { applied: true, wrote: true }]);
    expect(await plugins()).toBe('# header\r\nBase.esp\r\nOther.esp\r\n*New.esp\r\n');
  });

  it('a refusal does not block the next command: the write chain survives it', async () => {
    await appendPlugin(dir, PROFILE, 'Base.esp');
    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nOther.esp\r\n*New.esp\r\n');
  });
});

const provided = (...names: string[]) => new Map(names.map((n) => [n.toLowerCase(), n] as const));
const folded = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));

describe('pluginLinesDelta — what plugins.txt must gain and lose to match disk', () => {
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

describe('reconcilePlugins — plugins.txt converges on what disk provides', () => {
  let dir: string;
  const pluginsPath = () => join(dir, 'profiles', PROFILE, 'plugins.txt');
  const plugins = () => readFile(pluginsPath(), 'utf8');
  const mtime = async () => (await stat(pluginsPath())).mtime;
  // `null` = the game directory is unresolved (an explicit `undefined` would select the default).
  const run = (dataFolder: string | null = join(dir, 'Game', 'Data')) =>
    reconcilePlugins(dir, PROFILE, dataFolder ?? undefined, () => {});

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-reconcile-'));
    await mkdir(join(dir, 'mods', 'Provider'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Dormant'), { recursive: true });
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await mkdir(join(dir, 'Game', 'Data'), { recursive: true });
    await writeFile(join(dir, 'profiles', PROFILE, 'modlist.txt'), '+Provider\r\n-Dormant\r\n');
    await writeFile(join(dir, 'mods', 'Provider', 'Base.esp'), 'plugin');
    await writeFile(pluginsPath(), '# header\r\n*Base.esp\r\n');
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

    expect(await run()).toEqual({
      applied: true, wrote: true, append: ['Alpha.esl', 'FromCK.esp', 'zeta.esp'], prune: [],
    });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nAlpha.esl\r\nFromCK.esp\r\nzeta.esp\r\n');
  });

  it('prunes a line whose plugin nothing provides, and keeps one the game Data folder provides', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n*DLCCoast.esm\r\n');

    expect(await run()).toEqual({ applied: true, wrote: true, append: [], prune: ['Gone.esp'] });
    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
  });

  it('a plugin hidden the MO2 way (.mohidden suffix) is not present: never appended, and its line is pruned', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Hidden.esp.mohidden'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\nHidden.esp\r\n');

    await run();

    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('an implicit master (a vanilla plugin in Data) that an enabled mod also ships is never appended: the tree has no line-backed row for it', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), buildTes4Buffer([]));
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), buildTes4Buffer([]));

    expect(await run()).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\n');
  });

  it('a Data folder that resolved but is gone from disk refuses: nothing pruned, nothing written', async () => {
    await writeFile(pluginsPath(), '*Base.esp\r\n*DLCCoast.esm\r\n');
    await rm(join(dir, 'Game', 'Data'), { recursive: true });

    expect(await run()).toEqual({ applied: false, refusal: expect.stringContaining('ENOENT') });
    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
  });

  it('a modlist that cannot be read refuses rather than reading as "every mod vanished"', async () => {
    await writeFile(pluginsPath(), '*Base.esp\r\n');
    await rm(join(dir, 'profiles', PROFILE, 'modlist.txt'));

    expect(await run()).toEqual({ applied: false, refusal: expect.stringContaining('ENOENT') });
    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('with the game directory unresolved, still appends but prunes nothing', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');

    expect(await run(null)).toEqual({ applied: true, wrote: true, append: ['New.esp'], prune: [] });
    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\nNew.esp\r\n');
  });

  it('an empty delta writes nothing at all: the file on disk is not touched', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    expect(await run()).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await mtime()).toEqual(old);
  });
});
