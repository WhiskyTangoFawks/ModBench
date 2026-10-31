import * as vscode from 'vscode';
import { onSettingChange } from '../drivingLib/setting';
import type { DeploymentRowSetting } from './ToolboxProvider';

const meditConfig = () => vscode.workspace.getConfiguration('modbench');

const GAME_FOLDER_SETTING_KEY = 'mods.gameFolder';

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export const gameFolderSetting = {
  id: `modbench.${GAME_FOLDER_SETTING_KEY}`,
  value: () => meditConfig().get<string>(GAME_FOLDER_SETTING_KEY),
  changed: (listener) => onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${GAME_FOLDER_SETTING_KEY}`, listener),
};

const DEPLOYMENT_FOLDER_SETTING_KEY = 'deployment.folder';

export const deploymentFolderSetting: DeploymentRowSetting = {
  id: `modbench.${DEPLOYMENT_FOLDER_SETTING_KEY}`,
  inspect: () => meditConfig().inspect<string>(DEPLOYMENT_FOLDER_SETTING_KEY),
  nameOf: (path) => vscode.Uri.file(path).path.split('/').findLast((part) => part !== '') ?? '',
  changed: (listener) => onSettingChange(vscode.workspace.onDidChangeConfiguration, `modbench.${DEPLOYMENT_FOLDER_SETTING_KEY}`, listener),
};
