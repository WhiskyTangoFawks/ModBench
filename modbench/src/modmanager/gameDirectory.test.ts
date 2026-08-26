import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGameDirectory, normalizeGamePath } from './gameDirectory';

/** A minimal stand-in for vscode's WorkspaceConfiguration. */
function fakeConfig(values: Record<string, string>) {
  return { get: (key: string) => values[key] };
}

const noDetect = () => Promise.resolve(null);
const noDetectPrefix = () => Promise.resolve(null);

describe('normalizeGamePath', () => {
  it('leaves a native Windows path untouched', async () => {
    expect(await normalizeGamePath('C:\\Games\\Fallout4', 'win32', noDetectPrefix)).toBe('C:\\Games\\Fallout4');
  });

  it('leaves a colon that is not a leading drive letter untouched (only the drive-letter prefix is stripped)', async () => {
    // Unlike Windows, a colon elsewhere in a path is legal on Linux (e.g. a mod folder someone
    // named literally "A:B") — an unanchored strip would corrupt it.
    const path = '/home/wayne/mods/A:B/Fallout4';
    expect(await normalizeGamePath(path, 'linux', noDetectPrefix)).toBe(path);
  });

  it('maps a Z: drive path straight to the filesystem root, without consulting the prefix', async () => {
    let calledPrefix = false;
    const detectPrefix = () => {
      calledPrefix = true;
      return Promise.resolve(null);
    };

    const result = await normalizeGamePath('Z:\\home\\wayne\\Games\\Fallout4', 'linux', detectPrefix);

    expect(result).toBe('/home/wayne/Games/Fallout4');
    expect(calledPrefix).toBe(false);
  });

  it("maps a C: drive path inside the Proton prefix's drive_c", async () => {
    const prefix = '/home/wayne/.steam/steam/steamapps/compatdata/377160/pfx';
    const detectPrefix = () => Promise.resolve(prefix);

    const result = await normalizeGamePath('C:\\Games\\Fallout4', 'linux', detectPrefix);

    expect(result).toBe(join(prefix, 'drive_c', 'Games/Fallout4'));
  });

  it('surfaces (throws), rather than guesses, when a C: path\'s prefix cannot be determined', async () => {
    await expect(
      normalizeGamePath('C:\\Games\\Fallout4', 'linux', () => Promise.resolve(null)),
    ).rejects.toThrow(/prefix/i);
  });

  it('surfaces (throws) for a drive letter that is neither Z nor C, rather than silently stripping it to root', async () => {
    await expect(
      normalizeGamePath('D:\\Games\\Fallout4', 'linux', () => Promise.resolve('/some/prefix')),
    ).rejects.toThrow(/drive/i);
  });
});

describe('resolveGameDirectory', () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('resolves an explicit modbench.mods.gameDirectory setting directly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });

    const resolved = await resolveGameDirectory(
      dir,
      fakeConfig({ 'mods.gameDirectory': gameRoot }),
      noDetect,
      noDetectPrefix,
    );

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('trims whitespace accidentally pasted around an explicit setting value', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });

    const resolved = await resolveGameDirectory(
      dir,
      fakeConfig({ 'mods.gameDirectory': `  ${gameRoot}  ` }),
      noDetect,
      noDetectPrefix,
    );

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('errors (not silently falls through) when the explicit setting has no Data/ subfolder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(gameRoot, { recursive: true }); // no Data/ underneath

    await expect(
      resolveGameDirectory(dir, fakeConfig({ 'mods.gameDirectory': gameRoot }), noDetect, noDetectPrefix),
    ).rejects.toThrow(/Data\//);
  });

  it('falls back to the MO2 ini gamePath when the setting is unset', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(${gameRoot})\r\n`);

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect, noDetectPrefix);

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it('normalizes a Wine drive-mapped ini gamePath to its POSIX path (the real-LitR case)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const gameRoot = join(dir, 'Stock Game Folder');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    // MO2 under Proton stores the path as a Wine Z: drive with backslashes.
    const winePath = 'Z:' + gameRoot.replaceAll('/', '\\');
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(${winePath})\r\n`);

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect, noDetectPrefix);

    expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
  });

  it("normalizes a C: drive-mapped ini gamePath into the Proton prefix's drive_c (#187)", async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const prefixDir = await mkdtemp(join(tmpdir(), 'medit-prefix-'));
    const gameRoot = join(prefixDir, 'drive_c', 'Games', 'Fallout4');
    await mkdir(join(gameRoot, 'Data'), { recursive: true });
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(C:\\Games\\Fallout4)\r\n`);
    const detectPrefix = () => Promise.resolve(prefixDir);

    try {
      const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect, detectPrefix);

      expect(resolved).toEqual({ root: gameRoot, dataFolder: join(gameRoot, 'Data') });
    } finally {
      await rm(prefixDir, { recursive: true, force: true });
    }
  });

  it('errors (does not fall through to autodetect) when the ini has a C: path but the prefix cannot be determined', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(C:\\Games\\Fallout4)\r\n`);
    let autodetectCalled = false;
    const detect = () => {
      autodetectCalled = true;
      return Promise.resolve(null);
    };

    await expect(
      resolveGameDirectory(dir, fakeConfig({}), detect, noDetectPrefix),
    ).rejects.toThrow(/prefix/i);
    expect(autodetectCalled).toBe(false);
  });

  it('falls back to GamePathDetector autodetect when the setting and ini are both absent', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const detectedData = join(dir, 'Steam', 'Fallout 4', 'Data');
    const detect = () => Promise.resolve({ dataFolder: detectedData, pluginsTxt: 'ignored' });

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), detect, noDetectPrefix);

    expect(resolved).toEqual({ root: join(dir, 'Steam', 'Fallout 4'), dataFolder: detectedData });
  });

  it('falls through a resolved-but-invalid ini gamePath (no Data/) to autodetect, rather than trusting it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));
    const staleGameRoot = join(dir, 'Stale Game Folder');
    await mkdir(staleGameRoot, { recursive: true }); // no Data/ underneath — a broken/moved install
    await writeFile(join(dir, 'ModOrganizer.ini'), `[General]\r\ngamePath=@ByteArray(${staleGameRoot})\r\n`);
    const detectedData = join(dir, 'Steam', 'Fallout 4', 'Data');
    const detect = () => Promise.resolve({ dataFolder: detectedData, pluginsTxt: 'ignored' });

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), detect, noDetectPrefix);

    expect(resolved).toEqual({ root: join(dir, 'Steam', 'Fallout 4'), dataFolder: detectedData });
  });

  it('returns null when nothing resolves — explicit unset, ini absent, autodetect finds nothing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'medit-gamedir-'));

    const resolved = await resolveGameDirectory(dir, fakeConfig({}), noDetect, noDetectPrefix);

    expect(resolved).toBeNull();
  });
});
