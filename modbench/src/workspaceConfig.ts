import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { GameDirectoryOverrides } from './instanceAdapter/instanceAdapter';
import type { FilterScripts } from './plugins/recordFilterCommands';

export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export function gameDirectoryOverrides(): GameDirectoryOverrides {
  return { gameDirectory: meditConfig().get<string>('mods.gameDirectory') };
}

/** The record filter's scripts folder over the disk, which the Plugins view holds no door onto. */
export function setupScriptsFolder(cfg: vscode.WorkspaceConfiguration): FilterScripts {
  const scriptsPathCfg: string = cfg.get('scriptsPath') ?? '';
  const scriptsPath = scriptsPathCfg || path.join(os.homedir(), '.medit', 'scripts');
  fs.mkdirSync(scriptsPath, { recursive: true });

  return {
    folder: scriptsPath,
    sqlFiles: () => (fs.existsSync(scriptsPath) ? fs.readdirSync(scriptsPath).filter((f) => f.endsWith('.sql')) : []),
    read: (name) => fs.readFileSync(path.join(scriptsPath, name), 'utf8'),
    nameOf: (uri) => path.basename(uri.fsPath),
  };
}
