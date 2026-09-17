import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPlugin, reconcilePlugins, reorderPlugins, setPluginEnabled } from '../plugins';
import { providedPluginsIn } from '../../test/mo2/corpusFixture';
import { isPluginFile } from '../../mo2Files/pluginFile';
import type { DataFolderPlugins } from '../../instance/loadOrderSnapshot';

const PROFILE = 'Default';
const INITIAL = '# header\r\n*Base.esp\r\nOther.esp\r\n';
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

// expect.stringContaining's type is `any`, so this narrows the refusal branch by hand instead.
function assertRefusal(result: { applied: boolean; refusal?: string }, expectedSubstring: string): void {
  if (result.applied) throw new Error('expected a refusal, got applied:true');
  expect(result.refusal).toContain(expectedSubstring);
}

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
    assertRefusal(await setPluginEnabled(dir, PROFILE, 'No Such.esp', false), 'No Such.esp');
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('reorderPlugins writes the moved line at the winning end', async () => {
    expect(await reorderPlugins(dir, PROFILE, ['Other.esp'], { kind: 'winningEnd' })).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nOther.esp\r\n*Base.esp\r\n');
  });

  it('reorderPlugins refuses a name with no line, naming it, and writes nothing', async () => {
    assertRefusal(await reorderPlugins(dir, PROFILE, ['No Such.esp'], { kind: 'winningEnd' }), 'No Such.esp');
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('appendPlugin writes an enabled line at the winning end', async () => {
    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nOther.esp\r\n*New.esp\r\n');
  });

  it('appendPlugin refuses a name that already has a line, and writes nothing', async () => {
    assertRefusal(await appendPlugin(dir, PROFILE, 'Base.esp'), 'Base.esp');
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('a profile with no plugins.txt refuses rather than creating one', async () => {
    const result = await setPluginEnabled(dir, 'NoSuchProfile', 'Base.esp', false);
    assertRefusal(result, 'ENOENT');
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

describe('reconcilePlugins — plugins.txt converges on what disk provides', () => {
  let dir: string;
  const pluginsPath = () => join(dir, 'profiles', PROFILE, 'plugins.txt');
  const plugins = () => readFile(pluginsPath(), 'utf8');
  const mtime = async () => (await stat(pluginsPath())).mtime;
  const logs: string[] = [];
  const dataFolder = () => join(dir, 'Game', 'Data');

  // What the value carries when the folder resolved and the listing threw: the read's own reason,
  // which is the refusal the Output channel shows.
  const UNREADABLE: DataFolderPlugins = {
    kind: 'unreadable',
    reason: "ENOENT: no such file or directory, scandir '/game/Data'",
  };

  // The Instance's `dataFolderPlugins` field, doubled: presence at the Data folder's root,
  // case-folded, which is the argument the reconcile takes.
  const inDataOnDisk = async (): Promise<DataFolderPlugins> => {
    const dirents = await readdir(dataFolder(), { withFileTypes: true });
    const names = dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name.toLowerCase());
    return { kind: 'listed', names: new Set(names) };
  };

  // `null` is the game directory that never resolved; `undefined` selects the default, which is
  // what the folder on disk holds. A backend that could not answer is `implicit` null.
  const run = async (
    inData?: DataFolderPlugins | null,
    implicit: readonly string[] | null = [],
  ) => reconcilePlugins(
    dir, PROFILE, await providedPluginsIn(dir, PROFILE, dataFolder()),
    inData === null ? { kind: 'unresolved' } : (inData ?? await inDataOnDisk()),
    () => Promise.resolve(implicit ?? undefined), (m) => logs.push(m));

  beforeEach(async () => {
    logs.length = 0;
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

  it('never appends from Data: a Data-folder plugin with no line stays unlisted', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');

    expect(await run()).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\n');
  });

  it('a line differing only in case from the provided name is the same plugin: neither appended nor pruned', async () => {
    await writeFile(pluginsPath(), '# header\r\n*BASE.esp\r\n');

    expect(await run()).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await plugins()).toBe('# header\r\n*BASE.esp\r\n');
  });

  it('a plugin hidden the MO2 way (.mohidden suffix) is not present: never appended, and its line is pruned', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Hidden.esp.mohidden'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\nHidden.esp\r\n');

    await run();

    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('an implicit master the backend reports, which an enabled mod also ships, is never appended: the tree has no line-backed row for it', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), 'vanilla');
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s copy');

    expect(await run(undefined, ['Fallout4.esm'])).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\n');
  });

  // The rival this forbids: ignoring the backend's answer. Then the mod's copy is an ordinary
  // unlisted plugin and earns a line.
  it('appends a mod-shipped vanilla plugin the backend does not call implicit', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), 'vanilla');
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s copy');

    expect(await run(undefined, [])).toEqual({
      applied: true, wrote: true, append: ['Fallout4.esm'], prune: [],
    });
  });

  it('an implicit master matches its plugins.txt line case-insensitively', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s copy');

    expect(await run(undefined, ['FALLOUT4.ESM'])).toEqual({ applied: true, wrote: false, append: [], prune: [] });
  });

  // A resolved folder nobody could read is not "nothing is there": appending against half an
  // answer would list a plugin the game already loads, so the run refuses with the read's reason.
  it('refuses when the Data folder resolved and could not be read, writing nothing', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');

    assertRefusal(await run(UNREADABLE), 'ENOENT');
    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\n');
  });

  // Rival: refuse on unknown implicit masters too. That run wrote nothing either way, so the
  // earlier answer stands and the refusal never reaches the log.
  it('answers the unknown implicit masters first, even when the Data folder could not be read', async () => {
    expect(await run(UNREADABLE, null)).toEqual({ applied: true, wrote: false, append: [], prune: [] });
  });

  // A game directory that never resolved is the other unknowable, and a milder one: pruning
  // against it would delete every line, so nothing is pruned and appending goes on.
  it('with the game directory unresolved, still appends but prunes nothing', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');

    expect(await run(null)).toEqual({ applied: true, wrote: true, append: ['New.esp'], prune: [] });
    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\nNew.esp\r\n');
  });

  // Unknowable, not empty: treating an unreachable backend as "no implicit masters" would append
  // a line for every mod-shipped vanilla master and prune every line naming one.
  it('with the implicit masters unknown, appends and prunes nothing, and says so in the log', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    expect(await run(undefined, null)).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\n');
    expect(await mtime()).toEqual(old);
    expect(logs.join('\n')).toContain('implicit masters are unknown');
  });

  it('an empty delta writes nothing at all: the file on disk is not touched', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    expect(await run()).toEqual({ applied: true, wrote: false, append: [], prune: [] });
    expect(await mtime()).toEqual(old);
  });
});
