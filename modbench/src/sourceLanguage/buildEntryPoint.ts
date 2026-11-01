import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { BUILD_FILE } from '../wire/sourceMod';

const BUILD_TARGETS_KEY = 'modbench.source.buildTargets';

interface BuildEntryPointDeps {
  instance: Pick<Instance, 'value' | 'subscribe'>;
  reporter: Pick<Reporter, 'report'>;
}

function modsByBuildTarget(sourceDirs: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  return new Map([...sourceDirs].flatMap(([mod, folder]) => {
    const uri = vscode.Uri.file(folder);
    return [[uri.toString(), mod], [vscode.Uri.joinPath(uri, BUILD_FILE).toString(), mod]] as const;
  }));
}

export const isUri = (value: unknown): value is vscode.Uri =>
  typeof value === 'object' && value !== null && 'fsPath' in value && 'scheme' in value;

/** The Explorer menu and the run button of a source mod's source folder or build file (source.md, Menus and keys): an
 *  internal entry point that fires `build` with the mods those resources stand for. */
export function registerBuildEntryPoint({ instance, reporter }: BuildEntryPointDeps): vscode.Disposable {
  const publish = ({ paths }: Pick<Instance['value'], 'paths'>): void => {
    void vscode.commands.executeCommand('setContext', BUILD_TARGETS_KEY, [...modsByBuildTarget(paths.sourceDirs).keys()]);
  };
  publish(instance.value);
  const subscription = instance.subscribe(publish);
  const command = vscode.commands.registerCommand('modbench.source.build', async (clicked?: unknown, selected?: readonly unknown[]) => {
    const targets = modsByBuildTarget(instance.value.paths.sourceDirs);
    const mods = new Set<string>();
    for (const resource of (selected ?? [clicked]).filter(isUri)) {
      const mod = targets.get(resource.toString());
      if (mod === undefined) reporter.report('error', `Could not build "${resource.fsPath}".`, 'It is not a source mod\'s source folder or build file.');
      else mods.add(mod);
    }
    const rows = [...mods].map((name) => ({ argument: { kind: 'mod', name } }));
    if (rows.length > 0) await vscode.commands.executeCommand('modbench.mod.build', rows[0], rows);
  });
  return new vscode.Disposable(() => { subscription.dispose(); command.dispose(); });
}
