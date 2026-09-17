// New Plugin's two remaining destinations, composed the way pluginListCommands.ts's registered
// command does: the Instance's value names the folder, the backend lands the bytes there
// (simulated here), then appendPlugin adds the plugins.txt line.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { Instance } from '../instance/instance';
import { resolvePluginDestination, type PluginDestinationChoice } from './pluginDestination';
import { appendPlugin } from '../pluginsCommands/plugins';
import { present } from '../ports/present';

const PROFILE = 'Default';

describe('New Plugin lands the file and the plugins.txt line, for both remaining destinations', () => {
  let dir: string;
  let instance: Instance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'new-plugin-destination-'));
    await mkdir(join(dir, 'overwrite'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Existing Mod'), { recursive: true });
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), '[General]\r\nselected_profile=@ByteArray(Default)\r\ngameName=Fallout 4\r\n');
    await writeFile(join(dir, 'profiles', PROFILE, 'modlist.txt'), '+Existing Mod\r\n');
    await writeFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
    instance = new Instance({
      instanceRoot: dir,
      resolveGameDirectory: () => Promise.resolve(undefined),
      log: () => {},
    });
    await instance.refresh();
  });

  afterEach(async () => {
    instance.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  const landAt = async (choice: PluginDestinationChoice): Promise<void> => {
    const destination = present(
      resolvePluginDestination(instance.value, choice), 'the destination the value names');
    await writeFile(join(destination.path, 'New.esp'), '');
  };

  it('overwrite/: the file lands there and plugins.txt gains an enabled line', async () => {
    await landAt({ kind: 'overwrite' });

    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    await expect(readFile(join(dir, 'overwrite', 'New.esp'))).resolves.toBeDefined();
    expect(await readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8')).toContain('*New.esp');
  });

  it('an existing mod: the file lands under mods/<name> and plugins.txt gains an enabled line', async () => {
    await landAt({ kind: 'existingMod', modName: 'Existing Mod' });

    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    await expect(readFile(join(dir, 'mods', 'Existing Mod', 'New.esp'))).resolves.toBeDefined();
    expect(await readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8')).toContain('*New.esp');
  });
});
