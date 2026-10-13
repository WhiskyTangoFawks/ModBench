import { delimiter } from 'node:path';
import type * as vscode from 'vscode';
import type { MEditClient } from './client';

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
