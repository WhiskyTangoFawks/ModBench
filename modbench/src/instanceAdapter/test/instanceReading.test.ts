import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS } from '../../test/mo2/corpusFixture';
import { sourceOver } from '../../test/mo2/adapterOver';
import { readInstance, readPluginsProvided, type ReadingSource } from '../instanceReading';
import type { GameFolder } from '../instanceAdapter';
import { settleWaitArmed } from '../../test/eventually';

const INI = 'ModOrganizer.ini';

describe('the instance assembled from a manager\'s reading', () => {
  let dir: string;
  let source: ReadingSource;
  beforeEach(() => {
    dir = cloneCorpusFixture();
    source = sourceOver(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const text = (relative: string): Promise<string> => readFile(join(dir, relative), 'utf8');

  it('names the manager\'s mod order file in a repeat note, and takes the manager\'s key for what repeats', async () => {
    await appendFile(join(dir, DEFAULT_MODLIST), '-Patch Mod\n+PATCH MOD\n');
    const other = {
      ...source,
      names: { manager: 'Other', modOrderFile: 'order.txt', downloadedFileMetadataFile: '.metadata' },
      modLineKey: ({ kind, name }: { kind: string; name: string }) => `${kind}:${name}`,
    };

    const { orderNotes } = await readInstance(other);

    expect(orderNotes).toEqual(['order.txt lists the mod Patch Mod on more than one line; the first line holds']);
  });

  it('keeps the first plugin line of a name the plugin order repeats in another case, and a note names the repeat', async () => {
    const before = await readInstance(source);
    await appendFile(join(dir, DEFAULT_PLUGINS), 'NONASCIIRETEXTURE.ESP\n');

    const reading = await readInstance(source);

    expect(reading.pluginOrder).toEqual(before.pluginOrder);
    expect(reading.orderNotes).toEqual(['plugins.txt lists the plugin NONASCIIRETEXTURE.ESP on more than one line; the first line holds']);
  });

  it('words each link the source could not follow as a note naming its path and why', async () => {
    const skipping = { ...source, modFolders: (skip: (path: string, reason: string) => void) => { skip('/inst/mods/Loop', 'too many levels'); return source.modFolders(skip); } };

    const { linkNotes } = await readInstance(skipping);

    expect(linkNotes).toEqual(['/inst/mods/Loop is a link Modbench cannot follow, so it is not read: too many levels']);
  });

  it('counts each link the game folder\'s listings ignored once, whichever listing met it', async () => {
    const meeting = {
      ...source,
      gameFolderPlugins: (gameFolder: GameFolder, ignored: (path: string) => void) => { ignored('/game/Data/a.esp'); ignored('/game/Data/b.esp'); return source.gameFolderPlugins(gameFolder, ignored); },
      gameFolderArchives: (gameFolder: GameFolder, release: string | undefined, ignored: (path: string) => void) => { ignored('/game/Data/b.esp'); return source.gameFolderArchives(gameFolder, release, ignored); },
    };

    expect((await readInstance(meeting)).gameFolderLinks).toBe(2);
  });

  it('reads the settings once, so one reading holds one generation of the ini', async () => {
    let reads = 0;
    const counting = { ...source, settings: () => { reads++; return source.settings(); } };

    await readInstance(counting);

    expect(reads).toBe(1);
  });

  it('answers every fact against the ini as it read it, even when the ini is rewritten mid-reading', async () => {
    const rewriting = {
      ...source,
      settings: async () => {
        const settings = await source.settings();
        await writeFile(join(dir, INI), (await text(INI)).replace('gameName=Fallout 4', 'gameName=Skyrim VR'));
        return settings;
      },
    };

    const reading = await readInstance(rewriting);

    expect(reading.gameName).toBe('Fallout 4');
    expect((await readInstance(source)).gameName).toBe('Skyrim VR');
  });

  it('reads each listed mod\'s meta once, so one reading holds one answer for it', async () => {
    const reads: string[] = [];
    const counting = { ...source, modMeta: (mod: string) => { reads.push(mod); return source.modMeta(mod, 'list'); } };

    const reading = await readInstance(counting);

    const listed = reading.mods.filter((e) => e.kind === 'mod').map((e) => e.name);
    expect(reads.filter((mod) => listed.includes(mod)).sort()).toEqual([...listed].sort());
  });

  it('does not read the meta of a folder the mod order does not list while the downloads are unresolved, so an unreadable one does not fail the reading', async () => {
    await mkdir(join(dir, 'mods', 'Unlisted'));
    const unreadable = {
      ...source,
      settings: async () => ({
        ...(await source.settings()),
        downloadedFiles: () => Promise.resolve({ kind: 'unresolved' as const, reason: 'no downloads' }),
      }),
      modMeta: (mod: string) => (mod === 'Unlisted' ? Promise.reject(new Error('EACCES')) : source.modMeta(mod, 'list')),
    };

    await expect(readInstance(unreadable)).resolves.toMatchObject({ downloadedFiles: { kind: 'unresolved' } });
  });

  it.each<[string, (read: ReadingSource) => Promise<unknown>, () => Promise<unknown>]>([
    ['the instance whole', async (read) => (await readInstance(read)).mods.map((e) => e.name), async () => (await source.modOrder('Default')).map((e) => e.name)],
    ['the plugins the mod order provides', async (read) => {
      const provided = await readPluginsProvided(read, 'Default');
      return provided.kind === 'listed' && provided.plugins.has('patch mod.esp');
    }, () => Promise.resolve(true)],
  ])('reads a mod order that parses to no entries again after a settle, believing the second read, for %s', async (_, readOver, expected) => {
    await mkdir(join(dir, 'game', 'Data'), { recursive: true });
    const path = join(dir, DEFAULT_MODLIST);
    const complete = await text(DEFAULT_MODLIST);
    await writeFile(path, '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reading = readOver(sourceOver(dir, { gameFolderSettingValue: join(dir, 'game') }));
      await settleWaitArmed();
      await writeFile(path, complete);
      await vi.advanceTimersByTimeAsync(1000);

      expect(await reading).toEqual(await expected());
    } finally {
      vi.useRealTimers();
    }
  });

  it('believes a mod order that is still empty after the settle', async () => {
    await writeFile(join(dir, DEFAULT_MODLIST), '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reading = readInstance(source);
      await settleWaitArmed();
      await vi.advanceTimersByTimeAsync(1000);

      expect((await reading).mods).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('listing the mod folders for a read of every mod', () => {
    const listingsOf = (): { counting: ReadingSource; listings: () => number } => {
      let listed = 0;
      return { counting: { ...source, modFolders: (skippedLink) => { listed++; return source.modFolders(skippedLink); } }, listings: () => listed };
    };

    it('lists them once to read the instance whole', async () => {
      const { counting, listings } = listingsOf();

      await readInstance(counting);

      expect(listings()).toBe(1);
    });

    it('lists them once to read the plugins the mod order provides', async () => {
      const { counting, listings } = listingsOf();

      await readPluginsProvided(counting, 'Default');

      expect(listings()).toBe(1);
    });
  });
});
