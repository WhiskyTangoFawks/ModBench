import * as vscode from 'vscode';
import type { GameDirectoryOverrides } from './instanceAdapter/instanceAdapter';

export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export function gameDirectoryOverrides(): GameDirectoryOverrides {
  return { gameDirectory: meditConfig().get<string>('mods.gameDirectory') };
}
