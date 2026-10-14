import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

export const REPOSITORY_KEY = 'modbench.modlist.hasRepository';
export const INSTANCE_ROOTS_KEY = 'modbench.modlist.instanceRoots';

/** Tells the menus whether the instance holds a repository, again after each value the Instance loader lands, and
 *  which Source Control root is the instance's (modlist-source.md, Menus and keys). */
export function publishRepository(
  instance: Pick<Instance, 'subscribe'>, instanceRoot: string, holdsRepository: () => Promise<boolean>,
): vscode.Disposable {
  void vscode.commands.executeCommand('setContext', INSTANCE_ROOTS_KEY, [vscode.Uri.file(instanceRoot).toString()]);
  const publish = (): void => {
    void holdsRepository().then((held) => vscode.commands.executeCommand('setContext', REPOSITORY_KEY, held));
  };
  publish();
  const subscription = instance.subscribe(publish);
  return new vscode.Disposable(() => { subscription.dispose(); });
}
