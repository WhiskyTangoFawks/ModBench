import * as vscode from 'vscode';
import type { GameFolderSetting } from './instanceAdapter/instanceAdapter';
import { declaredSetting, onSettingChange } from './drivingLib/setting';

const meditConfig = () => vscode.workspace.getConfiguration('modbench');
const onConfigurationChange = (listener: Parameters<typeof vscode.workspace.onDidChangeConfiguration>[0]) => vscode.workspace.onDidChangeConfiguration(listener);

const GAME_FOLDER_SETTING_KEY = 'mods.gameFolder';

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export const gameFolderSetting: GameFolderSetting = {
  id: `modbench.${GAME_FOLDER_SETTING_KEY}`,
  value: () => meditConfig().get<string>(GAME_FOLDER_SETTING_KEY),
  changed: (listener) => onSettingChange(onConfigurationChange, `modbench.${GAME_FOLDER_SETTING_KEY}`, listener),
};

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

export const stringsLanguage = (): string => declaredSetting(`modbench.${STRINGS_LANGUAGE_SETTING}`, meditConfig().get<string>(STRINGS_LANGUAGE_SETTING));

export const onStringsLanguageChange = (listener: () => void): vscode.Disposable =>
  onSettingChange(onConfigurationChange, `modbench.${STRINGS_LANGUAGE_SETTING}`, listener);

export const attachPort = (): number | null | undefined => meditConfig().get<number | null>('attachToBackendPort');
