import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

const io = vi.hoisted(() => ({
  read: [] as string[],
  listed: [] as string[],
  afterReading: undefined as { readonly path: string; readonly then: () => Promise<void> } | undefined,
}));

vi.mock('vscode', () => fakeVscodeModule());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      const [path] = args;
      if (typeof path === 'string') io.read.push(path);
      const hook = io.afterReading;
      if (hook !== undefined && path === hook.path) {
        io.afterReading = undefined;
        await hook.then();
      }
      return text;
    },
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      io.listed.push(args[0].toString());
      return actual.readdir(...args);
    },
  };
});

import { appendFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from '../../test/mo2/corpusFixture';
import { adapterOver } from '../../test/mo2/adapterOver';
import type { InstanceAdapter, PluginsProvided } from '../instanceAdapter';
import { settleWaitArmed } from '../../test/eventually';
import { downloadsUnresolvable, gameOnDisk } from './instanceOnDisk';
import { onPosix } from '../../test/platform';

const INI = 'ModOrganizer.ini';

describe('the instance assembled from a manager\'s reading', () => {
  let dir: string;
  let adapter: InstanceAdapter;
  beforeEach(() => {
    dir = cloneCorpusFixture();
    adapter = adapterOver(dir);
    io.read = [];
    io.listed = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const text = (relative: string): Promise<string> => readFile(join(dir, relative), 'utf8');
  const providedOver = async (over: InstanceAdapter): Promise<PluginsProvided | undefined> => {
    let provided: PluginsProvided | undefined;
    await over.changePluginOrderOverProvided('Default', (_order, handed) => { provided = handed; return []; });
    return provided;
  };

  it('keeps the first plugin line of a name the plugin order repeats in another case, and a note names the repeat', async () => {
    const before = await adapter.reading();
    await appendFile(join(dir, DEFAULT_PLUGINS), 'NONASCIIRETEXTURE.ESP\n');

    const reading = await adapter.reading();

    expect(reading.pluginOrder).toEqual(before.pluginOrder);
    expect(reading.orderNotes).toEqual(['plugins.txt lists the plugin NONASCIIRETEXTURE.ESP on more than one line; the first line holds']);
  });

  it('words each link the source could not follow as a note naming its path and why', async () => {
    await symlink('Loop', join(dir, 'mods', 'Loop'));

    const { linkNotes } = await adapter.reading();

    expect(linkNotes).toEqual([expect.stringContaining(`${join(dir, 'mods', 'Loop')} is a link Modbench cannot follow, so it is not read: `) as unknown]);
  });

  it('counts each link the game folder\'s listings ignored once, whichever listing met it', async () => {
    const game = await gameOnDisk({ 'deployed/a.esp': '', 'deployed/b.esp': '' });
    await symlink(join(game, 'deployed', 'a.esp'), join(game, 'Data', 'a.esp'));
    await symlink(join(game, 'deployed', 'b.esp'), join(game, 'Data', 'b.esp'));
    try {
      expect((await adapterOver(dir, { gameFolderSettingValue: game }).reading()).gameFolderLinks).toBe(2);
    } finally {
      await rm(game, { recursive: true, force: true });
    }
  });

  it('answers every fact against the ini as it read it, even when the ini is rewritten mid-reading', async () => {
    const before = await text(INI);
    io.afterReading = { path: join(dir, INI), then: () => writeFile(join(dir, INI), before.replace('gameName=Fallout 4', 'gameName=Skyrim VR')) };

    const reading = await adapter.reading();
    const next = await adapter.reading();

    expect([reading.gameName, reading.gameRelease, next.gameName, next.gameRelease]).toEqual(['Fallout 4', 'Fallout4', 'Skyrim VR', 'SkyrimVR']);
  });

  it('reads each listed mod\'s meta once, so one reading holds one answer for it', async () => {
    await adapter.reading();

    const metasRead = io.read.filter((path) => path.endsWith('meta.ini')).map((path) => path.slice(join(dir, 'mods').length + 1)).sort();
    expect(metasRead).toEqual([
      'Cracked and Smudged Pip-Boy Screen/meta.ini', 'ENBoost - 12k/meta.ini', 'Harder VATS/meta.ini', 'Patch Mod/meta.ini',
      'SKK Fast Start new game (Fallout 4)/meta.ini', 'Unofficial Fallout 4 Patch/meta.ini', 'Ñoño\'s Retexture/meta.ini',
    ].map((path) => join(path)));
  });

  onPosix.it('does not read the meta of a folder the mod order does not list while the downloads are unresolved, so an unreadable one does not fail the reading', async () => {
    await mkdir(join(dir, 'mods', 'Unlisted', 'meta.ini'), { recursive: true });
    await downloadsUnresolvable(dir);

    await expect(adapterOver(dir).reading()).resolves.toMatchObject({ downloadedFiles: { kind: 'unresolved' } });
  });

  it.each<[string, (over: InstanceAdapter) => Promise<unknown>, unknown]>([
    ['the instance whole', async (over) => (await over.reading()).mods.length, 10],
    ['the plugins the mod order provides', async (over) => {
      const provided = await providedOver(over);
      return provided?.kind === 'listed' && provided.plugins.has('patch mod.esp');
    }, true],
  ])('reads a mod order that parses to no entries again after a settle, believing the second read, for %s', async (_, readOver, expected) => {
    await mkdir(join(dir, 'game', 'Data'), { recursive: true });
    const path = join(dir, DEFAULT_MODLIST);
    const complete = await text(DEFAULT_MODLIST);
    await writeFile(path, '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reading = readOver(adapterOver(dir, { gameFolderSettingValue: join(dir, 'game') }));
      await settleWaitArmed();
      await writeFile(path, complete);
      await vi.advanceTimersByTimeAsync(1000);

      expect(await reading).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it('believes a mod order that is still empty after the settle', async () => {
    await writeFile(join(dir, DEFAULT_MODLIST), '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reading = adapter.reading();
      await settleWaitArmed();
      await vi.advanceTimersByTimeAsync(1000);

      expect((await reading).mods).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('listing the mod folders for a read of every mod', () => {
    const listingsOfMods = (): number => io.listed.filter((path) => path === join(dir, 'mods')).length;

    it('lists them once to read the instance whole', async () => {
      await adapter.reading();

      expect(listingsOfMods()).toBe(1);
    });

    it('lists them once to read the plugins the mod order provides', async () => {
      await providedOver(adapter);

      expect(listingsOfMods()).toBe(1);
    });
  });
});
