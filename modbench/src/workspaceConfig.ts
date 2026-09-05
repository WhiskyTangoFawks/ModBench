import * as vscode from 'vscode';
import { detectGamePaths } from './medit/GamePathDetector';
import type { DetectPaths } from './modmanager/gameDirectory';
import { mo2InstanceContext } from './modmanager/detectMo2Instance';

/** Vocabulary-neutral workspace facts both bounded contexts read, so they belong to neither
 *  context's folder nor to the composition root. */
export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** The explicit `game.*` overrides win only when both are set, else autodetect. */
export function makeDetectPaths(): DetectPaths {
  return () => {
    const c = meditConfig();
    const dataOverride = c.get<string>('game.dataFolderPath', '');
    const pluginsOverride = c.get<string>('game.pluginsTxtPath', '');
    if (dataOverride && pluginsOverride) {
      return Promise.resolve({ dataFolder: dataOverride, pluginsTxt: pluginsOverride });
    }
    return detectGamePaths(process.platform);
  };
}

/** The only place either MO2-instance context key is set; the two keys must always travel
 *  together. */
export function setMo2InstanceContext(isInstance: boolean): void {
  for (const [key, value] of Object.entries(mo2InstanceContext(isInstance))) {
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
