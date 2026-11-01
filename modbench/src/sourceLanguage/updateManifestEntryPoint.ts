import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { isUri } from './buildEntryPoint';

const SOURCE_FOLDERS_KEY = 'modbench.source.sourceFolders';

interface UpdateManifestEntryPointDeps {
  instance: Pick<Instance, 'value' | 'subscribe'>;
  reporter: Pick<Reporter, 'report'>;
}

const parentOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));

/** The Explorer menu of a manifest in a source mod's source folder (source.md, Menus and keys): an internal entry point
 *  that fires `update manifest` with the source folders those manifests lie in. */
export function registerUpdateManifestEntryPoint({ instance, reporter }: UpdateManifestEntryPointDeps): vscode.Disposable {
  const publish = ({ paths }: Pick<Instance['value'], 'paths'>): void => {
    void vscode.commands.executeCommand('setContext', SOURCE_FOLDERS_KEY, [...paths.sourceDirs.values()].map((folder) => vscode.Uri.file(folder).fsPath));
  };
  publish(instance.value);
  const subscription = instance.subscribe(publish);
  const command = vscode.commands.registerCommand('modbench.source.updateManifest', async (clicked?: unknown, selected?: readonly unknown[]) => {
    const folders = new Map([...instance.value.paths.sourceDirs.values()].map((folder) => [vscode.Uri.file(folder).toString(), folder]));
    const held = new Set<string>();
    for (const resource of (selected ?? [clicked]).filter(isUri)) {
      const folder = folders.get(vscode.Uri.file(parentOf(resource.fsPath)).toString());
      if (folder === undefined) reporter.report('error', `Could not update the manifest "${resource.fsPath}".`, 'It is not in a source mod\'s source folder.');
      else held.add(folder);
    }
    const rows = [...held].map((path) => ({ argument: { kind: 'folder', path } }));
    if (rows.length > 0) await vscode.commands.executeCommand('modbench.mod.updateManifest', rows[0], rows);
  });
  return new vscode.Disposable(() => { subscription.dispose(); command.dispose(); });
}
