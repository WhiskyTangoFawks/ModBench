import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mo2InstanceAdapter } from '../mo2Instance';
import type { GameDetectors, GameFolder } from '../gameDirectory';
import type { InstanceAdapter, ModFolder, ModlistEntry, ModOrderChange, PluginOrderChange } from '../instanceAdapter';
import { tempWritePath } from '../layout';
import {
  assertOnlyChanged, cloneCorpusFixture, DEFAULT_MODLIST, DEFAULT_PLUGINS, snapshotTree,
} from '../../test/mo2/corpusFixture';

const NO_DETECTORS: GameDetectors = {
  paths: () => Promise.resolve(null),
  winePrefix: () => Promise.resolve(null),
};

const INI = 'ModOrganizer.ini';
const DOWNLOAD = 'Unofficial Fallout 4 Patch-4598-2-1-5-1679096028.7z';

const adapterAt = (instanceRoot: string, gameDirectory?: string): InstanceAdapter =>
  mo2InstanceAdapter({ instanceRoot, gameDirectoryOverrides: () => ({ gameDirectory }), detectors: NO_DETECTORS });

const text = (root: string, relative: string): Promise<string> => readFile(join(root, relative), 'utf8');

const modNames = (order: readonly ModlistEntry[]): string[] => order.map((e) => `${e.kind}:${e.name}:${e.enabled}`);

async function isThere(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('the MO2 Instance adapter', () => {
  let root: string;
  let adapter: InstanceAdapter;

  beforeEach(async () => {
    root = await cloneCorpusFixture();
    adapter = adapterAt(root);
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  describe('parsed reads', () => {
    it('answers the selected profile and the game from the settings', async () => {
      const settings = await adapter.settings();

      expect(settings.profile).toBe('Default');
      expect(settings.gameName).toBe('Fallout 4');
    });

    it('rejects when the settings name no selected profile', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\n');

      await expect(adapter.settings()).rejects.toThrow(/selected_profile/);
    });

    it('finds the game folder the setting names', async () => {
      const game = await mkdtemp(join(tmpdir(), 'mo2-instance-game-'));
      try {
        await mkdir(join(game, 'Data'));

        const folder = await (await adapterAt(root, game).settings()).gameFolder();

        expect(folder).toEqual({ kind: 'found', root: game, dataFolder: join(game, 'Data') });
      } finally {
        await rm(game, { recursive: true, force: true });
      }
    });

    it('answers each place it looked when no game folder is found', async () => {
      const folder = await (await adapter.settings()).gameFolder();

      expect(folder.kind).toBe('notFound');
    });

    it('lists the downloaded files with their metadata parsed, and no metadata file as a file of its own', async () => {
      await writeFile(join(root, 'downloads', 'manual.zip'), 'zip');
      await mkdir(join(root, 'downloads', 'a folder'));
      await writeFile(tempWritePath(join(root, 'downloads', 'manual.zip.meta')), 'half');

      const downloads = await (await adapter.settings()).downloadedFiles();

      if (downloads.kind !== 'listed') throw new Error(`expected listed, got ${downloads.reason}`);
      expect(downloads.downloadsDir).toBe(join(root, 'downloads'));
      const byName = new Map((downloads.files ?? []).map((file) => [file.name, file]));
      expect([...byName.keys()].sort()).toEqual([DOWNLOAD, 'manual.zip']);
      expect(byName.get(DOWNLOAD)?.meta).toMatchObject({ status: 'Installed', modID: '4598', excluded: false });
      expect(byName.get('manual.zip')?.meta).toBeUndefined();
      expect(byName.get('manual.zip')?.size).toBe(3);
      expect(byName.get('manual.zip')?.path).toBe(join(root, 'downloads', 'manual.zip'));
      expect(byName.get('manual.zip')?.metaPath).toBe(join(root, 'downloads', 'manual.zip.meta'));
    });

    it('answers no files, rather than none, when the downloads folder is not there', async () => {
      await rm(join(root, 'downloads'), { recursive: true });

      expect(await (await adapter.settings()).downloadedFiles())
        .toEqual({ kind: 'listed', downloadsDir: join(root, 'downloads'), files: undefined });
    });

    // Rival: each answer reading the settings again, so a rewrite between two answers lands two
    // generations in one value.
    it('answers where the downloads are from the same read the profile came from', async () => {
      const settings = await adapter.settings();
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=@ByteArray(Default)\r\n'
        + '[Settings]\r\ndownload_directory=@ByteArray(elsewhere)\r\n');

      const downloads = await settings.downloadedFiles();

      expect(downloads).toMatchObject({ kind: 'listed', downloadsDir: join(root, 'downloads') });
    });

    it('answers every profile, and no stray file beside them', async () => {
      await writeFile(join(root, 'profiles', 'stray.txt'), '');

      expect((await adapter.profiles()).sort()).toEqual(['Default', 'Secondary']);
    });

    it('answers no profiles when the instance has none', async () => {
      await rm(join(root, 'profiles'), { recursive: true });

      expect(await adapter.profiles()).toEqual([]);
    });

    it('answers the mods and separators in mod order, winning end first', async () => {
      const order = await adapter.modOrder('Default');

      expect(modNames(order).slice(0, 4)).toEqual([
        "mod:Ñoño's Retexture:true",
        'mod:Tracked Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
      ]);
    });

    it('rejects a profile with no mod order to read', async () => {
      await expect(adapter.modOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    it('answers a mod\'s meta', async () => {
      expect(await adapter.modMeta('Unofficial Fallout 4 Patch')).toMatchObject({
        version: '2.1.5.0',
        nexusId: '4598',
        archiveFilename: DOWNLOAD,
      });
    });

    it('answers an empty meta for a mod with none', async () => {
      expect(await adapter.modMeta('DragIn Manual Extract')).toEqual({});
    });

    // Rival: any failure read as no meta, which publishes an unreadable meta as an empty one.
    it('rejects a meta that is there but cannot be read', async () => {
      await mkdir(join(root, 'mods', 'DragIn Manual Extract', 'meta.ini'));

      await expect(adapter.modMeta('DragIn Manual Extract')).rejects.toThrow(/EISDIR/);
    });

    it('answers every mod folder as the entry it holds, with its path', async () => {
      const folders = await adapter.modFolders();

      expect(folders).toContainEqual({
        kind: 'mod', name: 'Unofficial Fallout 4 Patch', path: join(root, 'mods', 'Unofficial Fallout 4 Patch'),
      });
      expect(folders).toContainEqual({
        kind: 'separator',
        name: 'Unassigned (Modlist Development)',
        path: join(root, 'mods', 'Unassigned (Modlist Development)_separator'),
      });
    });

    // Rival: the reserved overwrite name answered as a mod, which mod sync would then list.
    it('answers no entry for a folder named as the reserved overwrite folder', async () => {
      await mkdir(join(root, 'mods', 'Overwrite'));

      expect((await adapter.modFolders())?.map((f) => f.name)).not.toContain('Overwrite');
    });

    it('hands over a link it cannot follow rather than answering it as a folder', async () => {
      await symlink(join(root, 'mods', 'Loop'), join(root, 'mods', 'Loop'));
      const skipped: string[] = [];

      const folders = await adapter.modFolders((name) => skipped.push(name));

      expect(folders?.map((f) => f.name)).not.toContain('Loop');
      expect(skipped).toEqual(['Loop']);
    });

    it('answers undefined when there is no folder for mods at all', async () => {
      await rm(join(root, 'mods'), { recursive: true });

      expect(await adapter.modFolders()).toBeUndefined();
    });

    it('answers the plugins in plugin order, with their enabled state', async () => {
      expect(await adapter.pluginOrder('Default')).toEqual([
        { name: 'NonAsciiRetexture.esp', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: true },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
      ]);
    });

    it('rejects a profile with no plugin order to read', async () => {
      await expect(adapter.pluginOrder('No Such Profile')).rejects.toThrow(/ENOENT/);
    });

    describe('the game folder\'s plugins', () => {
      let game: string;

      beforeEach(async () => {
        game = await mkdtemp(join(tmpdir(), 'mo2-instance-data-'));
      });
      afterEach(() => rm(game, { recursive: true, force: true }));

      const found = (dataFolder: string): GameFolder => ({ kind: 'found', root: game, dataFolder });

      it('answers the plugin files at the Data folder\'s root, case-folded', async () => {
        const data = join(game, 'Data');
        await mkdir(join(data, 'Nested.esp'), { recursive: true });
        await writeFile(join(data, 'Fallout4.ESM'), '');
        await writeFile(join(data, 'Patch.esp'), '');
        await writeFile(join(data, 'readme.txt'), '');

        const plugins = await adapter.gameFolderPlugins(found(data));

        expect(plugins).toEqual({ kind: 'listed', names: new Set(['fallout4.esm', 'patch.esp']) });
      });

      it('answers unresolved when the game folder was not found', async () => {
        const notFound: GameFolder = { kind: 'notFound', looked: [], setting: 'setting' };

        expect(await adapter.gameFolderPlugins(notFound)).toEqual({ kind: 'unresolved' });
      });

      it('answers unreadable, with why, when the Data folder cannot be listed', async () => {
        const plugins = await adapter.gameFolderPlugins(found(join(game, 'Missing')));

        if (plugins.kind !== 'unreadable') throw new Error(`expected unreadable, got ${plugins.kind}`);
        expect(plugins.reason).toMatch(/ENOENT/);
      });
    });
  });

  describe('folder answers', () => {
    it('gives a separator name the name MO2 gives its folder', () => {
      expect(adapter.folderNameFor('  Core:  Mods.  ')).toBe('Core Mods');
      expect(adapter.folderNameFor('CON')).toBe('');
    });

    it('says whether a mod has a folder, and none for a name that escapes the mod folders', async () => {
      expect(await adapter.hasModFolder('Harder VATS')).toBe(true);
      expect(await adapter.hasModFolder('No Such Mod')).toBe(false);
      expect(await adapter.hasModFolder('../profiles')).toBe(false);
    });

    it('names the downloaded file at a path, and nothing for a path outside the downloads', async () => {
      expect(await adapter.downloadedFileAt(join(root, 'downloads', DOWNLOAD))).toBe(DOWNLOAD);
      expect(await adapter.downloadedFileAt(join(root, DOWNLOAD))).toBeUndefined();
    });

    it('creates a mod\'s folder, and refuses a name that escapes the mod folders', async () => {
      await adapter.createModFolder('Brand New');

      expect(await isThere(join(root, 'mods', 'Brand New'))).toBe(true);
      await expect(adapter.createModFolder('../escape')).rejects.toThrow(/Not a valid mod name/);
    });

    it('moves a mod\'s or a separator\'s folder to the trash, and answers false when it has none', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      };

      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'Harder VATS' }, trash)).toBe(true);
      expect(await adapter.trashEntryFolder({ kind: 'separator', name: 'Unassigned (Modlist Development)' }, trash)).toBe(true);
      expect(await adapter.trashEntryFolder({ kind: 'mod', name: 'No Such Mod' }, trash)).toBe(false);

      expect(trashed).toEqual([
        join(root, 'mods', 'Harder VATS'), join(root, 'mods', 'Unassigned (Modlist Development)_separator'),
      ]);
    });
  });

  describe('changes to mod order', () => {
    const change = (changes: readonly ModOrderChange[]) =>
      adapter.changeModOrder('Default', () => changes);
    const separatorFolder = (name: string): string => join(root, 'mods', `${name}_separator`);

    it('hands the decision the order and the mod folders as they stand', async () => {
      const seen: string[][] = [];
      let folders: readonly ModFolder[] | undefined;

      await adapter.changeModOrder('Default', (order, found) => {
        seen.push(modNames(order));
        folders = found;
        return [];
      });

      expect(seen).toEqual([modNames(await adapter.modOrder('Default'))]);
      expect(folders).toEqual(await adapter.modFolders());
    });

    it('lands every change in one write of mod order alone', async () => {
      const before = await snapshotTree(root);

      const written = await change([
        { kind: 'enable', mod: 'Harder VATS', enabled: true },
        { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'New Mod' } },
        { kind: 'addAtWinningEnd', entry: { kind: 'separator', name: 'Orphan' } },
        { kind: 'dropMod', mod: 'ENBoost - 12k' },
        { kind: 'dropSeparator', separator: 'Radfall - All-In-One Survival Overhaul' },
      ]);

      expect(written).toEqual({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_MODLIST]));
      expect(modNames(await adapter.modOrder('Default'))).toEqual([
        'separator:Orphan:false',
        'mod:New Mod:false',
        "mod:Ñoño's Retexture:true",
        'mod:Tracked Patch Mod:true',
        'mod:SKK Fast Start new game (Fallout 4):true',
        'separator:Unassigned (Modlist Development):false',
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'mod:Harder VATS:true',
        'mod:Cracked and Smudged Pip-Boy Screen:true',
      ]);
    });

    it('moves mods and separators to a place in mod order', async () => {
      await change([
        { kind: 'moveMods', mods: ['Harder VATS'], place: { kind: 'modOrder' }, end: 'winning' },
        {
          kind: 'moveSeparators',
          separators: ['Radfall - All-In-One Survival Overhaul'],
          place: { kind: 'modOrder' },
          end: 'winning',
        },
      ]);

      expect(modNames(await adapter.modOrder('Default')).slice(0, 3)).toEqual([
        'mod:[NODELETE] Radfall:true',
        'mod:Unofficial Fallout 4 Patch:true',
        'separator:Radfall - All-In-One Survival Overhaul:false',
      ]);
      expect(modNames(await adapter.modOrder('Default'))).toContain('mod:Harder VATS:false');
    });

    it('adds a separator with its folder', async () => {
      await change([{ kind: 'addSeparator', separator: 'New Separator', afterIndex: -1 }]);

      expect(modNames(await adapter.modOrder('Default'))[0]).toBe('separator:New Separator:true');
      expect(await isThere(separatorFolder('New Separator'))).toBe(true);
    });

    it('renames a separator\'s line and its folder as one change', async () => {
      await change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]);

      expect(modNames(await adapter.modOrder('Default'))).toContain('separator:Core Mods:false');
      expect(await isThere(separatorFolder('Core Mods'))).toBe(true);
      expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(false);
    });

    it('writes nothing when the changes are already true of mod order', async () => {
      const before = await text(root, DEFAULT_MODLIST);
      const mtime = (await stat(join(root, DEFAULT_MODLIST))).mtimeMs;

      expect(await change([{ kind: 'enable', mod: 'Tracked Patch Mod', enabled: true }])).toEqual({ wrote: false });

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
      expect((await stat(join(root, DEFAULT_MODLIST))).mtimeMs).toBe(mtime);
    });

    // Rival for each: a splice that finds no line to change and leaves the text as it was, so the
    // change is dropped in silence.
    it.each<[string, ModOrderChange]>([
      ['enable', { kind: 'enable', mod: 'No Such Mod', enabled: true }],
      ['moveMods', { kind: 'moveMods', mods: ['No Such Mod'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['moveSeparators', { kind: 'moveSeparators', separators: ['No Such Sep'], place: { kind: 'modOrder' }, end: 'winning' }],
      ['renameSeparator', { kind: 'renameSeparator', from: 'No Such Sep', to: 'Anything' }],
      ['dropMod', { kind: 'dropMod', mod: 'No Such Mod' }],
      ['dropSeparator', { kind: 'dropSeparator', separator: 'No Such Sep' }],
      ['addAtWinningEnd a listed mod', { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'Harder VATS' } }],
      ['addSeparator a listed separator', { kind: 'addSeparator', separator: 'Unassigned (Modlist Development)', afterIndex: 0 }],
      ['renameSeparator onto a listed separator', {
        kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Radfall - All-In-One Survival Overhaul',
      }],
    ])('rejects %s naming an entry that is not there, or adding one that is, and writes nothing', async (_, bad) => {
      const before = await text(root, DEFAULT_MODLIST);

      await expect(change([{ kind: 'enable', mod: 'Harder VATS', enabled: true }, bad])).rejects.toThrow(/modlist/);

      expect(await text(root, DEFAULT_MODLIST)).toBe(before);
    });

    // Rival: the order read before the change queues behind one already in flight, so the second
    // decides from an order the first is about to replace.
    it('decides each change from the order the change before it left', async () => {
      const seenBySecond: string[][] = [];

      await Promise.all([
        change([{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'First' } }]),
        adapter.changeModOrder('Default', (order) => {
          seenBySecond.push(order.map((e) => e.name));
          return [];
        }),
      ]);

      expect(seenBySecond[0]).toContain('First');
    });

    describe('a failed change writes nothing', () => {
      const modlist = (): string => join(root, DEFAULT_MODLIST);

      // Rival: the line written before the folder moves, so a folder that cannot move leaves the
      // line renamed over a folder of the old name.
      it('leaves line and folder as they were when the folder cannot be renamed', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await mkdir(join(separatorFolder('Core Mods'), 'occupied'), { recursive: true });

        await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
          .rejects.toThrow();

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
      });

      // Rival: no undo, so a line that cannot be written leaves the folder renamed alone.
      it('puts the folder back when the renamed line cannot be written', async () => {
        const before = await text(root, DEFAULT_MODLIST);
        await chmod(modlist(), 0o444);
        try {
          await expect(change([{ kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }]))
            .rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await text(root, DEFAULT_MODLIST)).toBe(before);
        expect(await isThere(separatorFolder('Unassigned (Modlist Development)'))).toBe(true);
        expect(await isThere(separatorFolder('Core Mods'))).toBe(false);
      });

      it('takes a new separator\'s folder away when its line cannot be written', async () => {
        await chmod(modlist(), 0o444);
        try {
          await expect(change([{ kind: 'addSeparator', separator: 'New Separator', afterIndex: -1 }])).rejects.toThrow();
        } finally {
          await chmod(modlist(), 0o644);
        }

        expect(await isThere(separatorFolder('New Separator'))).toBe(false);
      });
    });
  });

  describe('changes to plugin order', () => {
    const change = (changes: readonly PluginOrderChange[]) =>
      adapter.changePluginOrder('Default', () => changes);

    it('lands every change in one write of plugin order alone, keeping its byte-order mark', async () => {
      const before = await snapshotTree(root);

      const written = await change([
        { kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: false },
        { kind: 'drop', plugin: 'NonAsciiRetexture.esp' },
        { kind: 'add', plugin: 'New.esp' },
        { kind: 'move', plugins: ['ccSBJFO4003-Grenade.esl'], toIndex: 0 },
      ]);

      expect(written).toEqual({ wrote: true });
      assertOnlyChanged(before, await snapshotTree(root), new Set([DEFAULT_PLUGINS]));
      expect(await adapter.pluginOrder('Default')).toEqual([
        { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
        { name: 'Tracked Patch Mod.esp', enabled: false },
        { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
        { name: 'New.esp', enabled: false },
      ]);
      expect((await text(root, DEFAULT_PLUGINS)).startsWith('﻿')).toBe(true);
    });

    it('hands the decision the order as it stands', async () => {
      const seen: string[][] = [];

      await adapter.changePluginOrder('Default', (order) => {
        seen.push(order.map((p) => p.name));
        return [];
      });

      expect(seen).toEqual([(await adapter.pluginOrder('Default')).map((p) => p.name)]);
    });

    it('writes nothing when the changes are already true of plugin order', async () => {
      expect(await change([{ kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: true }])).toEqual({ wrote: false });
    });

    // Rival for each: a splice that finds no line to change and leaves the text as it was.
    it.each<[string, PluginOrderChange]>([
      ['enable', { kind: 'enable', plugin: 'No Such.esp', enabled: true }],
      ['move', { kind: 'move', plugins: ['No Such.esp'], toIndex: 0 }],
      ['drop', { kind: 'drop', plugin: 'No Such.esp' }],
      ['add a listed plugin', { kind: 'add', plugin: 'Tracked Patch Mod.esp' }],
    ])('rejects %s naming a plugin that is not there, or adding one that is, and writes nothing', async (_, bad) => {
      const before = await text(root, DEFAULT_PLUGINS);

      await expect(change([{ kind: 'enable', plugin: 'Tracked Patch Mod.esp', enabled: false }, bad]))
        .rejects.toThrow(/plugins\.txt/);

      expect(await text(root, DEFAULT_PLUGINS)).toBe(before);
    });
  });

  describe('a downloaded file\'s metadata', () => {
    const downloads = (): string => join(root, 'downloads');
    const metaOf = (name: string): Promise<string> => text(root, join('downloads', `${name}.meta`));

    beforeEach(() => writeFile(join(downloads(), 'manual.zip'), 'zip'));

    it('marks a downloaded file installed, creating its metadata when it has none', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Installed')).toEqual({ gone: false, wrote: true });

      const listed = await (await adapter.settings()).downloadedFiles();
      if (listed.kind !== 'listed') throw new Error(`expected listed, got ${listed.reason}`);
      expect(listed.files?.find((file) => file.name === 'manual.zip')?.meta?.status).toBe('Installed');
    });

    it('marks a downloaded file uninstalled beside its installed mark', async () => {
      await adapter.markDownloadedFile(DOWNLOAD, 'Uninstalled');

      expect(await metaOf(DOWNLOAD)).toMatch(/^uninstalled=true\r$/m);
      expect(await metaOf(DOWNLOAD)).toMatch(/^installed=true\r$/m);
    });

    it('marks a downloaded file excluded, and then included again', async () => {
      await adapter.markDownloadedFile(DOWNLOAD, 'Excluded');
      expect(await metaOf(DOWNLOAD)).toMatch(/removed=true/);

      await adapter.markDownloadedFile(DOWNLOAD, 'Included');
      expect(await metaOf(DOWNLOAD)).toMatch(/removed=false/);
    });

    // Rival: including writes its key whatever the file says, so a file at rest gains metadata.
    it('writes no metadata for a file already included', async () => {
      expect(await adapter.markDownloadedFile('manual.zip', 'Included')).toEqual({ gone: false, wrote: false });

      expect(await isThere(join(downloads(), 'manual.zip.meta'))).toBe(false);
    });

    // A metadata file beside no downloaded file is one MO2 never writes.
    it('marks nothing for a downloaded file that is gone', async () => {
      expect(await adapter.markDownloadedFile('gone.zip', 'Installed')).toEqual({ gone: true });

      expect(await isThere(join(downloads(), 'gone.zip.meta'))).toBe(false);
    });

    it('moves a downloaded file\'s metadata to the trash, and answers false when it has none', async () => {
      const trashed: string[] = [];
      const trash = (path: string): Promise<void> => {
        trashed.push(path);
        return Promise.resolve();
      };

      expect(await adapter.trashDownloadedFileMeta(DOWNLOAD, trash)).toBe(true);
      expect(await adapter.trashDownloadedFileMeta('manual.zip', trash)).toBe(false);

      expect(trashed).toEqual([join(downloads(), `${DOWNLOAD}.meta`)]);
    });
  });

  describe('landing a mod', () => {
    const meta = (mod: string): Promise<string> => text(root, join('mods', mod, 'meta.ini'));

    it('stages beside the mod folders, outside every one of them', async () => {
      const staged = await adapter.stagingFolder();

      expect(await isThere(staged)).toBe(true);
      expect(staged.startsWith(join(root, 'mods'))).toBe(false);
    });

    it('lands a new mod whole, its meta holding only the keys it is given', async () => {
      const staged = await adapter.stagingFolder();
      await writeFile(join(staged, 'meta.ini'), 'shipped=true\n');
      await writeFile(join(staged, 'New.esp'), '');

      await adapter.landNewMod('New Mod', staged, { gameName: 'Fallout4', installationFile: 'Mod-1.7z' });

      expect(await meta('New Mod')).toBe('[General]\ngameName=Fallout4\ninstallationFile=Mod-1.7z\n');
      expect(await isThere(join(root, 'mods', 'New Mod', 'New.esp'))).toBe(true);
      expect(await isThere(staged)).toBe(false);
    });

    describe('an upgrade', () => {
      const mod = 'Unofficial Fallout 4 Patch';
      const folder = (): string => join(root, 'mods', mod);
      const keepGit = (entry: string): boolean => entry === '.git' || entry === 'source';
      let staged: string;

      beforeEach(async () => {
        await mkdir(join(folder(), '.git'));
        await writeFile(join(folder(), 'Old.esp'), '');
        await mkdir(join(folder(), 'source', 'kept'), { recursive: true });
        staged = await adapter.stagingFolder();
        await writeFile(join(staged, 'New.esp'), '');
        await mkdir(join(staged, 'source', 'release'), { recursive: true });
        await writeFile(join(staged, '.gitignore'), 'release');
      });

      it('replaces the contents around each entry kept, taking the release\'s entries the folder has none of', async () => {
        await adapter.upgradeMod(mod, staged, { gameName: 'Fallout4' }, keepGit);

        expect(await isThere(join(folder(), '.git'))).toBe(true);
        expect(await isThere(join(folder(), 'source', 'kept'))).toBe(true);
        expect(await isThere(join(folder(), 'source', 'release'))).toBe(false);
        expect(await isThere(join(folder(), 'Old.esp'))).toBe(false);
        expect(await isThere(join(folder(), 'New.esp'))).toBe(true);
        expect(await isThere(join(folder(), '.gitignore'))).toBe(true);
      });

      // Rival: the meta read after the release's entries land, so a release shipping its own meta
      // replaces the keys the mod had.
      it('sets the keys over the meta the mod had before its contents went', async () => {
        await writeFile(join(staged, 'meta.ini'), 'shipped=true\r\n');

        await adapter.upgradeMod(mod, staged, { gameName: 'Fallout4', version: '2.2' }, keepGit);

        expect(await meta(mod)).toBe(
          `[General]\r\ngameName=Fallout4\r\nmodid=4598\r\nversion=2.2\r\ncategory="-1,"\r\ninstallationFile=${DOWNLOAD}\r\n`,
        );
      });
    });
  });

  describe('the selected profile', () => {
    it('selects a profile, touching the settings alone', async () => {
      const before = await snapshotTree(root);

      expect(await adapter.selectProfile('Secondary')).toEqual({ wrote: true });

      assertOnlyChanged(before, await snapshotTree(root), new Set([INI]));
      expect((await adapter.settings()).profile).toBe('Secondary');
    });

    // Rival: the profile written whatever the settings say, which rewrites an unwrapped value.
    it('writes nothing when the profile is already selected', async () => {
      await writeFile(join(root, INI), '[General]\r\ngameName=Fallout 4\r\nselected_profile=Default\r\n');
      const before = await text(root, INI);

      expect(await adapter.selectProfile('Default')).toEqual({ wrote: false });

      expect(await text(root, INI)).toBe(before);
    });
  });
});
