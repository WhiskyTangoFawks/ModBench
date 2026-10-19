import * as vscode from 'vscode';
import type { GameFolderSetting } from './instanceAdapter/instanceAdapter';

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

const GAME_FOLDER_SETTING_KEY = 'mods.gameFolder';

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export const gameFolderSetting: GameFolderSetting = {
  id: `modbench.${GAME_FOLDER_SETTING_KEY}`,
  value: () => meditConfig().get<string>(GAME_FOLDER_SETTING_KEY),
  changed: (listener) => vscode.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration(`modbench.${GAME_FOLDER_SETTING_KEY}`)) listener();
  }),
};

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

export function stringsLanguage(): string {
  return meditConfig().get<string>(STRINGS_LANGUAGE_SETTING, 'English');
}

export function onStringsLanguageChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration(`modbench.${STRINGS_LANGUAGE_SETTING}`)) listener();
  });
}

export function agentPort(): number {
  return meditConfig().get<number>('agent.port', 47200);
}

export function attachPort(): number | undefined {
  return meditConfig().get<number | null>('attachToBackendPort') ?? undefined;
}
