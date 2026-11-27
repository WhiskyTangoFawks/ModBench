import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../test/mo2/fakeVscodeWatcher';
import { onPosix, onWindows } from '../../../test/platform';
import { adapterAsBuilt, instanceOnDisk, qSettingsPath, settingsNaming } from '../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const steamRegistryKey = vi.hoisted(() => ({ printed: (): Promise<string> => Promise.reject(new Error('ENOENT: reg')) }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const run = promisify(actual.exec);
  const asked = (command: string, options?: object) => (command.startsWith('reg query "HKCU\\Software\\Valve\\Steam"')
    ? steamRegistryKey.printed().then((stdout) => ({ stdout, stderr: '' }))
    : run(command, options ?? {}));
  return { ...actual, exec: Object.assign(actual.exec.bind(undefined), { [promisify.custom]: asked }) };
});

const FO4_APP_ID = '377160';
const STEAM_PLACE = 'the Steam install';

const libraryFolders = (...libraries: readonly { readonly path: string; readonly apps: readonly string[] }[]): string => [
  '"libraryfolders"', '{',
  ...libraries.flatMap(({ path, apps }, n) => [`  "${n}"`, '  {', `    "path"    "${path}"`, '    "apps"', '    {', ...apps.map((app) => `      "${app}"    "1"`), '    }', '  }']),
  '}', '',
].join('\n');

describe('the game folder Steam names', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'steam-detect-'));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  });

  const folderWithData = async (...path: string[]): Promise<string> => {
    await mkdir(join(base, ...path, 'Data'), { recursive: true });
    return join(base, ...path);
  };
  const gameFolderNaming = async (gamePath?: string) =>
    adapterAsBuilt(await instanceOnDisk({ 'ModOrganizer.ini': settingsNaming('Fallout 4', ...(gamePath === undefined ? [] : [`gamePath=${qSettingsPath(gamePath)}`])) })).gameFolder();

  onPosix.describe('on Linux, from the libraryfolders.vdf of Steam in the home folder', () => {
    const steamListing = async (vdf: string | undefined): Promise<void> => {
      vi.stubEnv('HOME', join(base, 'home'));
      await mkdir(join(base, 'home', '.steam', 'steam', 'config'), { recursive: true });
      await Promise.all(vdf === undefined ? [] : [writeFile(join(base, 'home', '.steam', 'steam', 'config', 'libraryfolders.vdf'), vdf)]);
    };

    it('is under the library holding the app', async () => {
      await steamListing(libraryFolders({ path: join(base, 'library'), apps: [FO4_APP_ID, '220'] }));
      const root = await folderWithData('library', 'steamapps', 'common', 'Fallout 4');

      expect(await gameFolderNaming()).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });

    it('is not found when the VDF cannot be read', async () => {
      await steamListing(undefined);

      expect(await gameFolderNaming()).toMatchObject({ kind: 'notFound', looked: expect.arrayContaining([{ place: STEAM_PLACE, answer: 'the game is in no Steam library' }]) as unknown });
    });

    it.each([
      ['the library holding the app', [{ path: 'library', apps: [FO4_APP_ID] }]],
      ['the one of several libraries that holds the app', [{ path: 'default', apps: ['220'] }, { path: 'library', apps: [FO4_APP_ID] }]],
    ])('translates a C: game path into the drive_c of the compatdata prefix of %s', async (_, libraries) => {
      await steamListing(libraryFolders(...libraries.map(({ path, apps }) => ({ path: join(base, path), apps }))));
      const root = await folderWithData('library', 'steamapps', 'compatdata', FO4_APP_ID, 'pfx', 'drive_c', 'Games', 'Fallout4');

      expect(await gameFolderNaming('C:\\Games\\Fallout4')).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });

    it.each([
      ['the VDF cannot be read', undefined],
      ['the VDF has no library holding the app', libraryFolders({ path: '/mnt/games/steam', apps: ['220'] })],
    ])('finds no prefix for a C: game path when %s', async (_, vdf) => {
      await steamListing(vdf);

      expect(await gameFolderNaming('C:\\Games\\Fallout4')).toMatchObject({
        kind: 'notFound', looked: expect.arrayContaining([{ place: "ModOrganizer.ini's gamePath", answer: expect.stringMatching(/prefix could not be determined/) as unknown }]) as unknown,
      });
    });
  });

  onWindows.describe('on Windows, from the SteamPath the registry names', () => {
    const steamPathIs = (steamPath: string): void => {
      steamRegistryKey.printed = () => Promise.resolve(`HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    ${steamPath}\r\n`);
    };

    it('is under the SteamPath the registry names', async () => {
      const root = await folderWithData('Steam', 'steamapps', 'common', 'Fallout 4');
      steamPathIs(join(base, 'Steam').replaceAll('\\', '/'));

      expect(await gameFolderNaming()).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });

    it.each([
      ['the registry names no SteamPath', () => Promise.resolve('ERROR: The system was unable to find the specified registry key or value.\r\n')],
      ['the registry query itself fails (no reg.exe, no Steam)', () => Promise.reject(new Error('ENOENT: reg'))],
    ])('is not found when %s', async (_, printed) => {
      steamRegistryKey.printed = printed;

      expect(await gameFolderNaming()).toMatchObject({ kind: 'notFound', looked: expect.arrayContaining([{ place: STEAM_PLACE, answer: 'the game is in no Steam library' }]) as unknown });
    });

    it.each([
      ['the steamapps vdf names', 'steamapps', (library: string) => library.replaceAll('\\', '/')],
      ['the older config vdf layout names', 'config', (library: string) => library.replaceAll('\\', '/')],
      ['the vdf names in the real Windows form, backslashes escaped', 'steamapps', (library: string) => library.replaceAll('\\', '\\\\')],
    ])('is in the library %s', async (_, folder, spelled) => {
      const root = await folderWithData('SteamLibrary', 'steamapps', 'common', 'Fallout 4');
      await mkdir(join(base, 'Steam', folder), { recursive: true });
      await writeFile(join(base, 'Steam', folder, 'libraryfolders.vdf'), libraryFolders({ path: spelled(join(base, 'SteamLibrary')), apps: [FO4_APP_ID] }));
      steamPathIs(join(base, 'Steam'));

      expect(await gameFolderNaming()).toEqual({ kind: 'found', root, dataFolder: join(root, 'Data') });
    });
  });
});
