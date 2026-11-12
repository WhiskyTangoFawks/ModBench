import { isInsideAny } from '../drivingLib/insideFolders';
import type { InstanceValue } from '../instanceLoader/instance';

interface WorkspaceNoticeDeps {
  instance: { readonly value: Pick<InstanceValue, 'gameFolder'>; subscribe: (listener: () => void) => { dispose: () => unknown } };
  workspaceRoots: () => readonly string[];
  onWorkspaceChange: (listener: () => void) => { dispose: () => unknown };
  /** Undefined clears the status. */
  languageStatus: (text: string | undefined) => void;
}

/** Says, while the game gets files from a game folder outside the workspace, that paths are checked only against the
 *  instance (ADR-0001). */
export function feedWorkspaceNotice({ instance, workspaceRoots, onWorkspaceChange, languageStatus }: WorkspaceNoticeDeps): () => void {
  const say = () => {
    const { gameFolder } = instance.value;
    const outside = gameFolder.kind === 'found' && !isInsideAny(workspaceRoots(), gameFolder.dataFolder);
    languageStatus(gameFolder.kind === 'found' && outside ? `Paths are checked only against the instance: the game also gets files from ${gameFolder.root}, outside the workspace.` : undefined);
  };
  const subscriptions = [instance.subscribe(say), onWorkspaceChange(say)];
  say();
  return () => { for (const subscription of subscriptions) subscription.dispose(); };
}
