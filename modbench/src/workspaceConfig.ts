import * as vscode from 'vscode';
import type { GameDirectoryOverrides } from './mo2Files/gameDirectory';
import { mo2InstanceContext } from './modmanager/mo2InstanceContext';

/** Vocabulary-neutral workspace facts both bounded contexts read, so they belong to neither
 *  context's folder nor to the composition root. */
export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** The three settings that override where the game is, read fresh on each resolve. Reading them
 *  is all this does: MO2 files decides what they mean. */
export function gameDirectoryOverrides(): GameDirectoryOverrides {
  const c = meditConfig();
  return {
    gameDirectory: c.get<string>('mods.gameDirectory'),
    dataFolder: c.get<string>('game.dataFolderPath'),
    pluginsTxt: c.get<string>('game.pluginsTxtPath'),
  };
}

/** The only place either MO2-instance context key is set; the two keys must always travel
 *  together. */
export function setMo2InstanceContext(isInstance: boolean): void {
  for (const [key, value] of Object.entries(mo2InstanceContext(isInstance))) {
    void vscode.commands.executeCommand('setContext', key, value);
  }
}
