import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGameDirectory } from './gameDirectory';

/** A minimal stand-in for vscode's WorkspaceConfiguration. */
function fakeConfig(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

const noDetect = () => Promise.resolve(null);

describe('resolveGameDirectory', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('resolves an explicit mEdit.mods.gameDirectory setting directly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });

    const resolved = await resolveGameDirectory(
      dir,
      fakeConfig({ 'mods.gameDirectory': gameRoot }),
      noDetect,
    );

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('errors (not silently falls through) when the explicit setting has no Data/ subfolder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(gameRoot, { recursive: true }); // no Data/ underneath

    await expect(
      resolveGameDirectory(dir, fakeConfig({ 'mods.gameDirectory': gameRoot }), noDetect),
    ).rejects.toThrow(/Data\//);
  });

  it('falls back to the MO2 ini gamePath when the setting is unset', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(${gameRoot})\r\n`);

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect);

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('normalizes a Wine drive-mapped ini gamePath to its POSIX path (the real-LitR case)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    // MO2 under Proton stores the path as a Wine Z: drive with backslashes.
    const winePath = 'Z:' + gameRoot.replaceAll('/', '\\');
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(${winePath})\r\n`);

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect);

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('falls back to GamePathDetector autodetect when the setting and ini are both absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const detectedData = join(dir, 'Steam', 'Fallout 4', 'Data');
    const detect = () => Promise.resolve({ dataFolder: detectedData, pluginsTxt: 'ignored' });

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), detect);

    expect(resolved).toEqual({ root: join(dir, 'Steam', 'Fallout 4'), dataFolder: detectedData });
  });
});
