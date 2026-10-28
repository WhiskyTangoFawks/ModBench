import { posix, win32 } from 'node:path';
import { archiveListsOf } from '../tables/gamePaths';

const SETUP_PAGE = 'https://github.com/WhiskyTangoFawks/ModBench/blob/main/docs/wiki/deployment-on-linux.md';
const NO_FOLDER_KNOWN = 'Modbench knows no folder where this game reads plugins.txt';

/** Where the game reads plugins.txt, or why deploy writes none. */
export type PluginsTxtWhere = { readonly folder: string } | { readonly why: string };

export type PluginsTxtPlace = (release: string | undefined, deploymentFolder: string) => Promise<PluginsTxtWhere>;

/** The Proton prefix of the non-Steam game that runs a program in a deployment folder, or why there is none. */
export type PrefixOf = (deploymentFolder: string) => Promise<{ readonly prefix: string } | { readonly why: string }>;

async function inPrefix(prefixOf: PrefixOf, deploymentFolder: string, gameFolder: string): Promise<PluginsTxtWhere> {
  const found = await prefixOf(deploymentFolder);
  if ('why' in found) return { why: `${found.why}; the page that sets it up: ${SETUP_PAGE}` };
  return { folder: posix.join(found.prefix, 'drive_c', 'users', 'steamuser', 'AppData', 'Local', gameFolder) };
}

/** Where the game reads plugins.txt: on Windows in the local application data, on Linux in the prefix of the non-Steam game in
 *  Steam, found by `prefixOf`, that runs a program in the deployment folder. */
export function pluginsTxtPlace(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, prefixOf: PrefixOf): PluginsTxtPlace {
  return async (release, deploymentFolder) => {
    const gameFolder = archiveListsOf(release)?.myGamesFolder;
    if (gameFolder === undefined) return { why: NO_FOLDER_KNOWN };
    if (platform === 'win32') {
      return env.LOCALAPPDATA ? { folder: win32.join(env.LOCALAPPDATA, gameFolder) } : { why: 'LOCALAPPDATA is not set' };
    }
    return inPrefix(prefixOf, deploymentFolder, gameFolder);
  };
}
