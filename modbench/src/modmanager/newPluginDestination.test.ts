// New Plugin's two remaining destinations, composed the way toolbox.ts's registered command
// does: resolvePluginDestination picks the path, the backend lands the bytes there (simulated
// here), then appendPlugin adds the plugins.txt line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginDestination } from './pluginDestination';
import { appendPlugin } from './commands/plugins';

const PROFILE = 'Default';

describe('New Plugin lands the file and the plugins.txt line, for both remaining destinations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'new-plugin-destination-'));
    await mkdir(join(dir, 'overwrite'), { recursive: true });
    await mkdir(join(dir, 'mods', 'Existing Mod'), { recursive: true });
    await mkdir(join(dir, 'profiles', PROFILE), { recursive: true });
    await writeFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), '*Base.esp\r\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('overwrite/: the file lands there and plugins.txt gains an enabled line', async () => {
    const destination = resolvePluginDestination(dir, { kind: 'overwrite' });
    await writeFile(join(destination.path, 'New.esp'), '');

    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    await expect(readFile(join(dir, 'overwrite', 'New.esp'))).resolves.toBeDefined();
    expect(await readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8')).toContain('*New.esp');
  });

  it('an existing mod: the file lands under mods/<name> and plugins.txt gains an enabled line', async () => {
    const destination = resolvePluginDestination(dir, { kind: 'existingMod', modName: 'Existing Mod' });
    await writeFile(join(destination.path, 'New.esp'), '');

    expect(await appendPlugin(dir, PROFILE, 'New.esp')).toEqual({ applied: true, wrote: true });
    await expect(readFile(join(dir, 'mods', 'Existing Mod', 'New.esp'))).resolves.toBeDefined();
    expect(await readFile(join(dir, 'profiles', PROFILE, 'plugins.txt'), 'utf8')).toContain('*New.esp');
  });
});
