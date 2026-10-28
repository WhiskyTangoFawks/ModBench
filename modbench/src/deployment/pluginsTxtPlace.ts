// Where the game reads plugins.txt differs per platform (deployment-hardlink.md, plugins.txt).

import { win32 } from 'node:path';
import { archiveListsOf } from '../tables/gamePaths';

export type PluginsTxtPlace = (release: string | undefined) => { readonly folder: string } | { readonly why: string };

/** On Windows the release's folder in the user's local application data, which is named as its My Games folder is.
 *  Every other platform is not yet written. */
export function pluginsTxtPlace(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): PluginsTxtPlace {
  return (release) => {
    if (platform !== 'win32') return { why: `deploy does not yet write plugins.txt on ${platform}` };
    const gameFolder = archiveListsOf(release)?.myGamesFolder;
    if (gameFolder === undefined) return { why: 'Modbench knows no folder where this game reads plugins.txt' };
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) return { why: 'LOCALAPPDATA is not set' };
    return { folder: win32.join(localAppData, gameFolder) };
  };
}
