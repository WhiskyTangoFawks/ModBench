import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { detectGamePaths, detectWinePrefix, type GameAutodetect } from './medit/GamePathDetector';
import type { DetectPaths, DetectWinePrefix } from './modmanager/gameDirectory';
import { mo2InstanceContext } from './modmanager/detectMo2Instance';
import { readGameName } from './mo2Codecs/modOrganizerIni';
import { gameReleaseForGame, gamePathInfoForRelease } from './tables/gamePaths';
import { settingsFile } from './mo2Codecs/layout';
import { loadOrderAppDataFolder } from './tables/loadOrderDestination';

/** Vocabulary-neutral workspace facts both bounded contexts read, so they belong to neither
 *  context's folder nor to the composition root. */
export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

// `undefined` when the ini can't be read, the release is unknown, or the tables hold no Steam
// facts for it — any of which leaves autodetection nothing to go on.
async function resolveGameAutodetect(instanceRoot: string): Promise<GameAutodetect | undefined> {
  let gameName: string;
  try {
    gameName = readGameName(await readFile(settingsFile(instanceRoot), 'utf8'));
  } catch {
    return undefined;
  }
  const release = gameReleaseForGame(gameName);
  if (!release) return undefined;
  const paths = gamePathInfoForRelease(release);
  const appDataFolder = loadOrderAppDataFolder(release);
  if (!paths?.steamAppId || !paths.steamFolderName || !appDataFolder) return undefined;
  return { steamAppId: paths.steamAppId, steamFolderName: paths.steamFolderName, loadOrderAppDataFolder: appDataFolder };
}

/** The explicit `game.*` overrides win only when both are set, else autodetect. */
export function makeDetectPaths(instanceRoot: string): DetectPaths {
  return async () => {
    const c = meditConfig();
    const dataOverride = c.get<string>('game.dataFolderPath', '');
    const pluginsOverride = c.get<string>('game.pluginsTxtPath', '');
    if (dataOverride && pluginsOverride) {
      return { dataFolder: dataOverride, pluginsTxt: pluginsOverride };
    }
    const game = await resolveGameAutodetect(instanceRoot);
    return game ? detectGamePaths(process.platform, game) : null;
  };
}

/** The Proton prefix for Wine drive-letter translation (gameDirectory.ts), resolved through the
 *  same per-game tables `makeDetectPaths` uses. */
export function makeDetectWinePrefix(instanceRoot: string): DetectWinePrefix {
  return async () => {
    const game = await resolveGameAutodetect(instanceRoot);
    return game ? detectWinePrefix(game.steamAppId) : null;
  };
}

/** The only place either MO2-instance context key is set; the two keys must always travel
 *  together. */
export function setMo2InstanceContext(isInstance: boolean): void {
  for (const [key, value] of Object.entries(mo2InstanceContext(isInstance))) {
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
