// create-plugin, Hand-off: the create writes only the file, in the folder the place names. The
// next instance value carries it, and plugin sync gives it its line at the end, disabled.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance } from '../instanceLoader/instance';
import { placeFolder } from '../plugins/pluginPlaces';
import { syncPlugins } from '../pluginsCommands/plugins';
import { pluginSyncArguments } from '../pluginSyncTrigger';
import { resolvesNoDownloads } from './mo2/downloadsUnresolved';
import type { GameDirectoryResolver } from '../instanceAdapter/gameDirectory';

const PROFILE = 'Default';

describe('a created plugin reaches plugins.txt through plugin sync alone', () => {
  let dir: string;
  let instance: Instance;
  const plugins = () => readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'new-plugin-destination-'));
    await mkdir(join(dir, 'overwrite'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Existing Mod'), { recursive: true });
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await mkdir(join(dir, 'Game', 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n');
    await writeFile(join(dir, 'profiles', PROFILE, 'modlist.txt'), '+Existing Mod\r\n');
    await writeFile(join(dir, 'mods', 'Existing Mod', 'Base.esp'), 'plugin');
    await writeFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
    const resolveGameDirectory: GameDirectoryResolver = () =>
      Promise.resolve({ kind: 'found', root: join(dir, 'Game'), dataFolder: join(dir, 'Game', 'Data') });
    instance = new Instance({
      instanceRoot: dir,
      resolveGameDirectory,
      resolveDownloadsDirectory: resolvesNoDownloads,
      log: () => {},
      logReadFailure: () => {},
    });
    await instance.refresh();
  });

  afterEach(async () => {
    instance.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['overwrite', 'Existing Mod'])('in %s: the line lands at the end, disabled', async (origin) => {
    const place = placeFolder(instance.value, origin);
    if (!('folder' in place)) throw new Error(`Expected the value to name a folder for ${origin}.`);
    await writeFile(join(place.folder, 'New.esp'), 'plugin');

    await instance.refresh();
    const { profile, provided, inData } = pluginSyncArguments(instance.value);
    const synced = await syncPlugins(dir, profile, provided, inData, () => Promise.resolve([]));

    expect(synced).toEqual({ applied: true, wrote: true, added: ['New.esp'], dropped: [] });
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });
});
