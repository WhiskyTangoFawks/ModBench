import type { InstanceValue } from '../instanceLoader/instance';

interface WorkspaceNoticeDeps {
  instance: { readonly value: Pick<InstanceValue, 'gameFolder' | 'gameFolderInWorkspace'>; subscribe: (listener: () => void) => { dispose: () => unknown } };
  /** Undefined clears the status. */
  languageStatus: (text: string | undefined) => void;
}

/** Says, while the game gets files from a game folder outside the workspace, that paths are checked only against the
 *  instance (ADR-0001). */
export function feedWorkspaceNotice({ instance, languageStatus }: WorkspaceNoticeDeps): () => void {
  const say = () => {
    const { gameFolder, gameFolderInWorkspace } = instance.value;
    languageStatus(gameFolder.kind === 'found' && !gameFolderInWorkspace ? `Paths are checked only against the instance: the game also gets files from ${gameFolder.root}, outside the workspace.` : undefined);
  };
  const subscription = instance.subscribe(say);
  say();
  return () => { subscription.dispose(); };
}
