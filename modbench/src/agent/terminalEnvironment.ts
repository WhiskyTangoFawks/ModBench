import { delimiter } from 'node:path';
import * as vscode from 'vscode';
import type { MEditClient } from '../client';

/** Replaces PYTHONPATH rather than prepending to it: a prepend leaves an empty entry when the terminal
 *  inherits none, and Python reads an empty entry as the working directory. */
export function reachMEditFromTerminals(
  collection: Pick<vscode.GlobalEnvironmentVariableCollection, 'persistent' | 'replace' | 'clear'>,
  client: Pick<MEditClient, 'onPort'>,
  scriptsPath: string,
  inheritedPythonPath: () => string | undefined,
  onInheritedChange: (listener: () => void) => vscode.Disposable,
): vscode.Disposable {
  collection.persistent = false;
  const replacePythonPath = () => {
    const inherited = inheritedPythonPath();
    collection.replace('PYTHONPATH', inherited ? scriptsPath + delimiter + inherited : scriptsPath);
  };
  replacePythonPath();
  const stopWatching = onInheritedChange(replacePythonPath);
  const stopHearing = client.onPort((port) => { collection.replace('MEDIT_PORT', String(port)); });
  return { dispose: () => { stopHearing(); stopWatching.dispose(); collection.clear(); } };
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
