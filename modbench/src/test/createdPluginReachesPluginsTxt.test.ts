import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance } from '../instanceLoader/instance';
import { placeFolder, type PlaceFolder } from '../plugins/pluginPlaces';
import { syncPlugins } from '../pluginsCommands/plugins';
import { accessTo, adapterOver, NO_DOWNLOADS, STEADY_WINDOW } from './mo2/adapterOver';

const PROFILE = 'Default';

function folderOf(place: PlaceFolder): string {
  if ('folder' in place) return place.folder;
  throw new Error(`Expected the value to name a folder, not ${JSON.stringify(place)}.`);
}

describe('a created plugin reaches plugins.txt through plugin sync alone', () => {
  let dir: string;
  let instance: Instance;
  const plugins = () => readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8');

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'create-plugin-handoff-'));
    await mkdir(join(dir, 'overwrite'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Existing Mod'), { recursive: true });
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await mkdir(join(dir, 'Game', 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n');
    await writeFile(join(dir, 'profiles', PROFILE, 'modlist.txt'), '+Existing Mod\r\n');
    await writeFile(join(dir, 'mods', 'Existing Mod', 'Base.esp'), 'plugin');
    await writeFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
    instance = new Instance({
      window: STEADY_WINDOW,
      adapter: adapterOver(dir, {
        gameFolder: { kind: 'found', root: join(dir, 'Game'), dataFolder: join(dir, 'Game', 'Data') },
        downloadedFiles: NO_DOWNLOADS,
      }),
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
    const folder = folderOf(placeFolder(instance.value, origin));
    await writeFile(join(folder, 'New.esp'), 'plugin');

    await instance.refresh();
    const synced = await syncPlugins(accessTo(dir), instance.value.pluginSyncArguments);

    expect(synced).toEqual({ applied: true, wrote: true, added: ['New.esp'], dropped: [] });
    expect(await plugins()).toBe('*Base.esp\r\nNew.esp\r\n');
  });
});
