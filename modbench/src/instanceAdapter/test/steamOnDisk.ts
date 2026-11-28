import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Machine } from '../instanceAdapter';

export const FO4_APP_ID = '377160';
const STEAM_KEY = 'HKCU\\Software\\Valve\\Steam';

/** A libraryfolders.vdf listing each library with the apps it holds. */
export const libraryFolders = (...libraries: readonly { readonly path: string; readonly apps: readonly string[] }[]): string => [
  '"libraryfolders"', '{',
  ...libraries.flatMap(({ path, apps }, n) => [`  "${n}"`, '  {', `    "path"    "${path}"`, '    "apps"', '    {', ...apps.map((app) => `      "${app}"    "1"`), '    }', '  }']),
  '}', '',
].join('\n');

/** Steam in `base`, where the home folder holds it and the registry names it, with the one library `base/library` holding `apps`
 *  and the game's folder; what the machine answers of it. */
export async function steamIn(base: string, apps: readonly string[] = [FO4_APP_ID]): Promise<Pick<Machine, 'homeFolder' | 'registryValue'>> {
  const homeFolder = join(base, 'home');
  const steam = join(homeFolder, '.steam', 'steam');
  await mkdir(join(steam, 'config'), { recursive: true });
  await writeFile(join(steam, 'config', 'libraryfolders.vdf'), libraryFolders({ path: join(base, 'library'), apps }));
  await mkdir(join(steamGameIn(base), 'Data'), { recursive: true });
  return {
    homeFolder,
    registryValue: (key, name) => (key === STEAM_KEY && name === 'SteamPath' ? Promise.resolve(steam) : Promise.reject(new Error(`${key} holds no ${name}`))),
  };
}

/** The folder the library of Steam in `base` installs a game in. */
export const steamGameIn = (base: string, folder = 'Fallout 4'): string => join(base, 'library', 'steamapps', 'common', folder);

/** The Proton prefix the library of Steam in `base` holds for `appId`. */
export const steamPrefixIn = (base: string, appId = FO4_APP_ID): string => join(base, 'library', 'steamapps', 'compatdata', appId, 'pfx');
