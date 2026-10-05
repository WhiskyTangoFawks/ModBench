import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncPlugins, reorderPlugins, setPluginsEnabled, setPluginsParticipation } from '../plugins';
import { accessTo, adapterOver, providedPluginsIn } from '../../test/mo2/adapterOver';
import { isPluginFile, type PluginOrderChange } from '../../instanceAdapter/instanceAdapter';
import type { DataFolderPlugins } from '../../instanceAdapter/instanceAdapter';

const PROFILE = 'Default';
const INITIAL = '# header\r\n*Base.esp\r\nOther.esp\r\n';
const LONG_AGO = new Date('2020-01-01T00:00:00Z');

function assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(result: { applied: boolean; refusal?: string }, expectedSubstring: string): void {
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

  it('reorderPlugins writes the moved line at the losing end, first in the file', async () => {
    expect(await reorderPlugins(accessTo(dir), PROFILE, ['Other.esp'], { kind: 'losingEnd' })).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nOther.esp\r\n*Base.esp\r\n');
  });

  it('reorderPlugins lands a block dragged down directly above the row it was dropped on, the splice counting after the block leaves the order', async () => {
    await writeFile(pluginsPath(), '*A.esp\r\n*B.esp\r\n*C.esp\r\n*D.esp\r\n*E.esp\r\n');
    expect(await reorderPlugins(accessTo(dir), PROFILE, ['A.esp'], { kind: 'before', name: 'D.esp' }))
      .toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('*B.esp\r\n*C.esp\r\n*A.esp\r\n*D.esp\r\n*E.esp\r\n');
  });

  it('reorderPlugins counts a moved row named in another case than plugins.txt writes it, landing the block above the target', async () => {
    await writeFile(pluginsPath(), '*A.esp\r\n*B.esp\r\n*C.esp\r\n*D.esp\r\n*E.esp\r\n');
    expect(await reorderPlugins(accessTo(dir), PROFILE, ['a.esp'], { kind: 'before', name: 'D.esp' }))
      .toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('*B.esp\r\n*C.esp\r\n*A.esp\r\n*D.esp\r\n*E.esp\r\n');
  });

  it('reorderPlugins of a block dropped on one of its own rows writes nothing', async () => {
    const order = '*A.esp\r\n*B.esp\r\n*C.esp\r\n*D.esp\r\n*E.esp\r\n';
    await writeFile(pluginsPath(), order);
    expect(await reorderPlugins(accessTo(dir), PROFILE, ['B.esp', 'C.esp', 'D.esp'], { kind: 'before', name: 'C.esp' }))
      .toEqual({ applied: true, wrote: false });
    expect(await plugins()).toBe(order);
  });

  it('reorderPlugins refuses a name with no line, naming it, and writes nothing', async () => {
    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(await reorderPlugins(accessTo(dir), PROFILE, ['No Such.esp'], { kind: 'losingEnd' }), 'No Such.esp');
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('reorderPlugins refuses a drop on a row plugins.txt does not list, naming it, and writes nothing rather than settling it at the winning end', async () => {
    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(
      await reorderPlugins(accessTo(dir), PROFILE, ['Other.esp'], { kind: 'before', name: 'Gone.esp' }),
      'Plugin not found in plugins.txt: Gone.esp');
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('a profile with no plugins.txt refuses rather than creating one', async () => {
    const result = await reorderPlugins(accessTo(dir), 'NoSuchProfile', ['Base.esp'], { kind: 'winningEnd' });
    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(result, 'ENOENT');
  });

  it('two gestures fired without awaiting the first both survive: neither read-modify-write is lost', async () => {
    const [first, second] = await Promise.all([
      setPluginsEnabled(accessTo(dir), PROFILE, ['Base.esp'], false),
      reorderPlugins(accessTo(dir), PROFILE, ['Other.esp'], { kind: 'losingEnd' }),
    ]);

    expect(first).toEqual({ applied: true, outcome: { landed: ['Base.esp'], refused: [] } });
    expect(second).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nOther.esp\r\nBase.esp\r\n');
  });

  it('a refusal does not block the next command: the write chain survives it', async () => {
    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(await reorderPlugins(accessTo(dir), PROFILE, ['No Such.esp'], { kind: 'losingEnd' }), 'No Such.esp');
    expect(await reorderPlugins(accessTo(dir), PROFILE, ['Other.esp'], { kind: 'losingEnd' })).toEqual({ applied: true, wrote: true });
    expect(await plugins()).toBe('# header\r\nOther.esp\r\n*Base.esp\r\n');
  });

  it('setPluginsEnabled(false) flips every named line in one splice', async () => {
    expect(await setPluginsEnabled(accessTo(dir), PROFILE, ['Base.esp', 'Other.esp'], false))
      .toEqual({ applied: true, outcome: { landed: ['Base.esp', 'Other.esp'], refused: [] } });
    expect(await plugins()).toBe('# header\r\nBase.esp\r\nOther.esp\r\n');
  });

  it('setPluginsParticipation, the check box\'s shape, flips each named line to its own state, in one splice', async () => {
    expect(await setPluginsParticipation(accessTo(dir), PROFILE, [{ name: 'Base.esp', enabled: false }, { name: 'Other.esp', enabled: true }]))
      .toEqual({ applied: true, outcome: { landed: ['Base.esp', 'Other.esp'], refused: [] } });
    expect(await plugins()).toBe('# header\r\nBase.esp\r\n*Other.esp\r\n');
  });

  it('setPluginsEnabled refuses a gone plugin by name, and the rest still land in the one splice', async () => {
    const result = await setPluginsEnabled(accessTo(dir), PROFILE, ['Base.esp', 'No Such.esp'], false);
    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Base.esp'], refused: [{ item: 'No Such.esp', reason: 'Plugin not found in plugins.txt: No Such.esp' }] },
    });
    expect(await plugins()).toBe('# header\r\nBase.esp\r\nOther.esp\r\n');
  });

  it('setPluginsEnabled to the state every line already has writes nothing', async () => {
    expect(await setPluginsEnabled(accessTo(dir), PROFILE, ['Base.esp'], true)).toEqual({
      applied: true, outcome: { landed: ['Base.esp'], refused: [] },
    });
    expect(await plugins()).toBe(INITIAL);
    expect(await mtime()).toEqual(LONG_AGO);
  });

  it('setPluginsEnabled refuses the whole selection once when the profile has no plugins.txt', async () => {
    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(await setPluginsEnabled(accessTo(dir), 'NoSuchProfile', ['Base.esp'], false), 'ENOENT');
  });
});

describe('syncPlugins — plugins.txt converges on what disk provides', () => {
  let dir: string;
  const pluginsPath = () => join(dir, 'profiles', PROFILE, 'plugins.txt');
  const plugins = () => readFile(pluginsPath(), 'utf8');
  const mtime = async () => (await stat(pluginsPath())).mtime;
  const dataFolder = () => join(dir, 'Game', 'Data');

  const UNREADABLE_WITH_THE_READS_OWN_REASON: DataFolderPlugins = {
    kind: 'unreadable',
    reason: "ENOENT: no such file or directory, scandir '/game/Data'",
  };

  const inDataOnDiskAsCaseFoldedNamesAtTheDataFoldersRoot = async (): Promise<DataFolderPlugins> => {
    const dirents = await readdir(dataFolder(), { withFileTypes: true });
    const names = dirents.filter((d) => d.isFile() && isPluginFile(d.name)).map((d) => d.name.toLowerCase());
    return { kind: 'listed', names: new Set(names) };
  };

  const run = async (inDataOrTheFolderOnDiskWhenUndefined?: DataFolderPlugins, loadedWithNoLine: readonly string[] = []) => syncPlugins(
    accessTo(dir), PROFILE, await providedPluginsIn(dir, PROFILE),
    inDataOrTheFolderOnDiskWhenUndefined ?? await inDataOnDiskAsCaseFoldedNamesAtTheDataFoldersRoot(), loadedWithNoLine);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugins-sync-'));
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
      applied: true, wrote: true, added: ['Alpha.esl', 'FromCK.esp', 'zeta.esp'], dropped: [],
    });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\nAlpha.esl\r\nFromCK.esp\r\nzeta.esp\r\n');
  });

  it('prunes a line whose plugin nothing provides, and keeps one the game Data folder provides', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n*DLCCoast.esm\r\n');

    expect(await run()).toEqual({ applied: true, wrote: true, added: [], dropped: ['Gone.esp'] });
    expect(await plugins()).toBe('*Base.esp\r\n*DLCCoast.esm\r\n');
  });

  it('writes the plugins.txt of the profile it is handed, and leaves the active profile\'s alone', async () => {
    const otherPath = join(dir, 'profiles', 'Other', 'plugins.txt');
    await mkdir(join(dir, 'profiles', 'Other'));
    await writeFile(join(dir, 'profiles', 'Other', 'modlist.txt'), '');
    await writeFile(otherPath, '*Gone.esp\r\n');
    const active = await plugins();

    const outcome = await syncPlugins(
      accessTo(dir), 'Other', await providedPluginsIn(dir, 'Other'), { kind: 'listed', names: new Set() }, []);

    expect(outcome).toEqual({ applied: true, wrote: true, added: [], dropped: ['Gone.esp'] });
    expect(await readFile(otherPath, 'utf8')).toBe('');
    expect(await plugins()).toBe(active);
  });

  it('never appends from Data: a Data-folder plugin with no line stays unlisted', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'DLCCoast.esm'), 'vanilla');

    expect(await run()).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\n');
  });

  it('a line differing only in case from the provided name is the same plugin: neither appended nor pruned', async () => {
    await writeFile(pluginsPath(), '# header\r\n*BASE.esp\r\n');

    expect(await run()).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
    expect(await plugins()).toBe('# header\r\n*BASE.esp\r\n');
  });

  it('a plugin hidden the MO2 way (.mohidden suffix) is not present: never appended, and its line is pruned', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Hidden.esp.mohidden'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\nHidden.esp\r\n');

    await run();

    expect(await plugins()).toBe('*Base.esp\r\n');
  });

  it('a plugin the game loads with no line, which an enabled mod also ships, is never appended: the tree has no line-backed row for it', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), 'vanilla');
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s plugin');

    expect(await run(undefined, ['Fallout4.esm'])).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
    expect(await plugins()).toBe('# header\r\n*Base.esp\r\n');
  });

  it('appends a mod-shipped vanilla plugin the game does not load with no line, as an ordinary unlisted plugin that earns a line', async () => {
    await writeFile(join(dir, 'Game', 'Data', 'Fallout4.esm'), 'vanilla');
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s plugin');

    expect(await run(undefined, [])).toEqual({
      applied: true, wrote: true, added: ['Fallout4.esm'], dropped: [],
    });
  });

  it('a plugin the game loads with no line matches its plugins.txt line case-insensitively', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'Fallout4.esm'), 'a mod\'s plugin');

    expect(await run(undefined, ['FALLOUT4.ESM'])).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
  });

  it('refuses when the Data folder resolved and could not be read, writing nothing, since appending against half an answer would list a plugin the game already loads', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');

    assertRefusalNarrowedByHandSinceExpectStringContainingIsTypedAny(await run(UNREADABLE_WITH_THE_READS_OWN_REASON), 'ENOENT');
    expect(await plugins()).toBe('*Base.esp\r\n*Gone.esp\r\n');
  });

  it('writes nothing when the game folder is not found, and leaves the telling to the instance\'s state rather than a refusal of its own', async () => {
    await writeFile(join(dir, 'mods', 'Provider', 'New.esp'), 'plugin');
    await writeFile(pluginsPath(), '*Base.esp\r\n*Gone.esp\r\n');
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    const result = await syncPlugins(
      accessTo(dir), PROFILE, await providedPluginsIn(dir, PROFILE), { kind: 'unresolved' }, undefined);

    expect(result).toEqual({ applied: false, toldAsInstanceState: true });
    expect(await mtime()).toEqual(old);
  });

  it('an empty delta writes nothing at all: the file on disk is not touched', async () => {
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(pluginsPath(), old, old);

    expect(await run()).toEqual({ applied: true, wrote: false, added: [], dropped: [] });
    expect(await mtime()).toEqual(old);
  });
});

describe('plugins commands hand the Instance adapter the change, decided on the order it holds', () => {
  const ORDER = [{ name: 'Base.esp', enabled: true }, { name: 'Gone.esp', enabled: false }];

  const adapterRecordingChanges = () => {
    const handed: (readonly PluginOrderChange[])[] = [];
    const access = {
      adapter: {
        ...adapterOver('/instance'),
        changePluginOrder: (_profile: string, decide: (order: typeof ORDER) => readonly PluginOrderChange[]) => {
          handed.push(decide(ORDER));
          return Promise.resolve({ wrote: true });
        },
      },
    };
    return { access, handed };
  };

  it('a move is its plugins and the index the drop settles to against that order', async () => {
    const { access, handed } = adapterRecordingChanges();
    await reorderPlugins(access, PROFILE, ['Base.esp'], { kind: 'after', name: 'Gone.esp' });
    expect(handed).toEqual([[{ kind: 'move', plugins: ['Base.esp'], toIndex: 1 }]]);
  });

  it('enable is a change for each plugin the order lists; one it does not is refused by name', async () => {
    const { access, handed } = adapterRecordingChanges();
    const result = await setPluginsEnabled(access, PROFILE, ['Base.esp', 'No Such.esp'], false);
    expect(handed).toEqual([[{ kind: 'enable', plugin: 'Base.esp', enabled: false }]]);
    expect(result).toEqual({
      applied: true,
      outcome: { landed: ['Base.esp'], refused: [{ item: 'No Such.esp', reason: 'Plugin not found in plugins.txt: No Such.esp' }] },
    });
  });

  it('plugin sync drops each line nothing provides and adds each provided plugin with none', async () => {
    const { access, handed } = adapterRecordingChanges();
    await syncPlugins(
      access, PROFILE, new Map([['base.esp', 'Base.esp'], ['new.esp', 'New.esp']]),
      { kind: 'listed', names: new Set() }, []);
    expect(handed).toEqual([[{ kind: 'drop', plugin: 'Gone.esp' }, { kind: 'add', plugin: 'New.esp' }]]);
  });
});
