import * as vscode from 'vscode';
import { GAME_FOLDER_SETTING, type GameDirectoryOverrides } from './instanceAdapter/instanceAdapter';

export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** Hears the game-folder setting change; the Instance adapter turns it into its own signal. */
export function onGameDirectoryChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration(GAME_FOLDER_SETTING)) listener();
  });
}

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export function gameDirectoryOverrides(): GameDirectoryOverrides {
  return { gameDirectory: meditConfig().get<string>('mods.gameDirectory') };
}
