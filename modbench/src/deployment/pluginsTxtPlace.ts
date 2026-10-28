import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { archiveListsOf } from '../tables/gamePaths';
import { errnoCode } from '../ports/errno';
import { shortcutsIn } from './steamShortcuts';

export const SETUP_PAGE = 'https://github.com/WhiskyTangoFawks/ModBench/blob/main/docs/wiki/deployment-on-linux.md';

export type PluginsTxtPlace = (release: string | undefined, deploymentFolder: string) => Promise<{ readonly folder: string } | { readonly why: string }>;

const NO_ROW = 'Modbench knows no folder where this game reads plugins.txt';

async function ifThere<T>(read: Promise<T>, otherwise: T): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return otherwise;
    throw err;
  }
}

const isWithin = (folder: string, path: string): boolean => {
  const below = relative(resolve(folder), resolve(path));
  return !below.startsWith('..') && !isAbsolute(below);
};

async function appIdRunningIn(steamRoot: string, deploymentFolder: string): Promise<number | undefined> {
  const users = join(steamRoot, 'userdata');
  for (const user of await ifThere(readdir(users), [])) {
    const file = await ifThere(readFile(join(users, user, 'config', 'shortcuts.vdf')), undefined);
    const found = file && shortcutsIn(file).find(({ exe }) => isWithin(deploymentFolder, exe));
    if (found) return found.appId;
  }
  return undefined;
}

async function inPrefix(steamRoot: string, deploymentFolder: string, gameFolder: string): Promise<{ folder: string } | { why: string }> {
  const appId = await appIdRunningIn(steamRoot, deploymentFolder);
  if (appId === undefined) return { why: `no non-Steam game in Steam runs a program in ${deploymentFolder}; set one up: ${SETUP_PAGE}` };
  const prefix = join(steamRoot, 'steamapps', 'compatdata', String(appId), 'pfx');
  if (!(await ifThere(stat(prefix), undefined))?.isDirectory()) return { why: `Steam has made no prefix at ${prefix} yet; launch the game once: ${SETUP_PAGE}` };
  return { folder: join(prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Local', gameFolder) };
}

/** Where the game reads plugins.txt: on Windows in the local application data, on Linux in the prefix of the non-Steam game in
 *  Steam, found under `steamRoot`, that runs a program in the deployment folder. */
export function pluginsTxtPlace(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, steamRoot: string | undefined): PluginsTxtPlace {
  return async (release, deploymentFolder) => {
    const gameFolder = archiveListsOf(release)?.myGamesFolder;
    if (gameFolder === undefined) return { why: NO_ROW };
    if (platform === 'win32') {
      return env.LOCALAPPDATA ? { folder: win32.join(env.LOCALAPPDATA, gameFolder) } : { why: 'LOCALAPPDATA is not set' };
    }
    if (steamRoot === undefined) return { why: `Modbench found no Steam; set one up: ${SETUP_PAGE}` };
    return inPrefix(steamRoot, deploymentFolder, gameFolder);
  };
}
