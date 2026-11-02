import * as vscode from 'vscode';

interface PythonExtensionApi {
  readonly environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri): { readonly path: string };
    resolveEnvironment(path: string): PromiseLike<{ readonly executable: { readonly uri?: vscode.Uri } } | undefined>;
  };
}

// The interpreter the Python extension selects for the window's first folder, none when no Python extension or no interpreter is there.
export async function selectedInterpreter(): Promise<string | undefined> {
  const python = vscode.extensions.getExtension<PythonExtensionApi>('ms-python.python');
  if (python === undefined) return undefined;
  const { environments } = await python.activate();
  const active = environments.getActiveEnvironmentPath(vscode.workspace.workspaceFolders?.[0]?.uri);
  return (await environments.resolveEnvironment(active.path))?.executable.uri?.fsPath;
}
