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

const TERMINAL_ENV_SETTING = { linux: 'env.linux', darwin: 'env.osx', win32: 'env.windows' } as const;

function terminalEnvSetting(): string {
  return TERMINAL_ENV_SETTING[process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux'];
}

/** The PYTHONPATH a terminal starts with: the user's terminal.integrated.env setting for this platform
 *  if it sets one, else the extension host's own. */
export function inheritedPythonPath(): string | undefined {
  const env = vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, string | null>>(terminalEnvSetting());
  return env?.PYTHONPATH ?? process.env.PYTHONPATH;
}

export function onTerminalEnvChange(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((change) => {
    if (change.affectsConfiguration(`terminal.integrated.${terminalEnvSetting()}`)) listener();
  });
}
