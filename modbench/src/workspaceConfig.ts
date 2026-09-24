import * as vscode from 'vscode';
import type { GameDirectoryOverrides } from './instanceAdapter/gameDirectory';
import { FOLDER_KEY, INSTANCE_READ_KEY, type FolderCheck } from './folderContext';
import type { InstanceView } from './instanceLoader/instance';

/** Vocabulary-neutral workspace facts both bounded contexts read, so they belong to neither
 *  context's folder nor to the composition root. */
export const meditConfig = () => vscode.workspace.getConfiguration('modbench');

/** The setting that overrides where the game is, read fresh on each resolve. Reading it is all
 *  this does: the Instance adapter decides what it means. */
export function gameDirectoryOverrides(): GameDirectoryOverrides {
  return { gameDirectory: meditConfig().get<string>('mods.gameDirectory') };
}

export function answerInstanceCheck(root: string | undefined, isInstance: (root: string) => boolean): FolderCheck {
  const answer: FolderCheck = root !== undefined && isInstance(root) ? 'instance' : 'notAnInstance';
  void vscode.commands.executeCommand('setContext', FOLDER_KEY, answer);
  return answer;
}

export interface FirstReadMark extends vscode.Disposable {
  readonly landed: boolean;
}

/** A failed read lands no value, so the key waits for the first read that does. */
export function markFirstReadLanded(instance: Pick<InstanceView, 'subscribe'>): FirstReadMark {
  let landed = false;
  const subscription = instance.subscribe(() => {
    subscription.dispose();
    landed = true;
    void vscode.commands.executeCommand('setContext', INSTANCE_READ_KEY, true);
  });
  return { get landed() { return landed; }, dispose: () => { subscription.dispose(); } };
}
