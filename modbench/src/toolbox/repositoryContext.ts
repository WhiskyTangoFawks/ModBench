import * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';

const REPOSITORY_KEY = 'modbench.modlist.hasRepository';
const INSTANCE_ROOTS_KEY = 'modbench.modlist.instanceRoots';

/** Tells the menus whether the instance holds a repository, from each value the Instance loader lands, and which
 *  Source Control root is the instance's (modlist-source.md, Menus and keys). */
export function publishRepository(instance: Pick<Instance, 'value' | 'subscribe'>, instanceRoot: string): vscode.Disposable {
  void vscode.commands.executeCommand('setContext', INSTANCE_ROOTS_KEY, [vscode.Uri.file(instanceRoot).toString()]);
  const publish = (held: boolean): void => {
    void vscode.commands.executeCommand('setContext', REPOSITORY_KEY, held);
  };
  publish(instance.value.holdsRepository);
  const subscription = instance.subscribe((value) => { publish(value.holdsRepository); });
  return new vscode.Disposable(() => { subscription.dispose(); });
}
