import * as vscode from 'vscode';
import type { Instance, InstanceValue } from '../instanceLoader/instance';

const REPOSITORY_KEY = 'modbench.modlist.hasRepository';
const SET_UP_KEY = 'modbench.modlist.repositorySetUp';
const INSTANCE_ROOTS_KEY = 'modbench.modlist.instanceRoots';

/** Tells the menus whether the instance holds a repository and whether git init has set it up, from each value the
 *  Instance loader lands, and which Source Control root is the instance's (modlist-repository.md, Menus and keys). */
export function publishRepository(instance: Pick<Instance, 'value' | 'subscribe'>, instanceRoot: string): vscode.Disposable {
  void vscode.commands.executeCommand('setContext', INSTANCE_ROOTS_KEY, [vscode.Uri.file(instanceRoot).toString()]);
  const publish = ({ holdsRepository, repositorySetUp }: Pick<InstanceValue, 'holdsRepository' | 'repositorySetUp'>): void => {
    void vscode.commands.executeCommand('setContext', REPOSITORY_KEY, holdsRepository);
    void vscode.commands.executeCommand('setContext', SET_UP_KEY, repositorySetUp);
  };
  publish(instance.value);
  const subscription = instance.subscribe(publish);
  return new vscode.Disposable(() => { subscription.dispose(); });
}
