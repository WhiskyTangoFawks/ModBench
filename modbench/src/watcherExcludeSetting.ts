import * as vscode from 'vscode';
import { onSettingChange } from './drivingLib/setting';
import type { WatcherExclude } from './instanceAdapter/instanceAdapter';

export const watcherExcludeSetting: WatcherExclude = {
  value: () => vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('watcherExclude', {}),
  changed: (listener) => onSettingChange(vscode.workspace.onDidChangeConfiguration, 'files.watcherExclude', listener),
};
