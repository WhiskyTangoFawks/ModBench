import { basename } from 'node:path';
import * as vscode from 'vscode';
import type { GameFolderSetting } from './instanceAdapter/instanceAdapter';
import type { DeploymentFolderSetting } from './toolbox/ToolboxProvider';
import { onSettingChange } from './drivingLib/setting';

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

const GAME_FOLDER_SETTING_KEY = 'mods.gameFolder';

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export const gameFolderSetting: GameFolderSetting = {
  id: `modbench.${GAME_FOLDER_SETTING_KEY}`,
  value: () => meditConfig().get<string>(GAME_FOLDER_SETTING_KEY),
  changed: (listener) => onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${GAME_FOLDER_SETTING_KEY}`, listener),
};

const DEPLOYMENT_FOLDER_SETTING_KEY = 'deployment.folder';

export const deploymentFolderSetting: DeploymentFolderSetting = {
  id: `modbench.${DEPLOYMENT_FOLDER_SETTING_KEY}`,
  inspect: () => meditConfig().inspect<string>(DEPLOYMENT_FOLDER_SETTING_KEY),
  nameOf: basename,
  changed: (listener) => onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${DEPLOYMENT_FOLDER_SETTING_KEY}`, listener),
};

const STRINGS_LANGUAGE_SETTING = 'stringsLanguage';

export const stringsLanguage = (): string | undefined => meditConfig().get<string>(STRINGS_LANGUAGE_SETTING);

export const onStringsLanguageChange = (listener: () => void): vscode.Disposable =>
  onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${STRINGS_LANGUAGE_SETTING}`, listener);

export const attachPort = (): number | null | undefined => meditConfig().get<number | null>('attachToBackendPort');
