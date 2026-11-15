import type { InstanceValue } from '../instanceLoader/instance';
import { outsideGameFolder } from '../instanceLoader/outsideGameFolder';

const NOTICE_READ = { gameFolder: true, gameFolderInWorkspace: true } as const;

interface WorkspaceNoticeDeps {
  instance: {
    readonly value: Pick<InstanceValue, keyof typeof NOTICE_READ>; subscribe: (listener: () => void, concerns: typeof NOTICE_READ) => { dispose: () => unknown };
  };
  /** Undefined clears the status. */
  languageStatus: (text: string | undefined) => void;
}

/** Says, while the game gets files from a game folder outside the workspace, that paths are checked only against the
 *  instance and scripts not at all (ADR-0001). */
export function feedWorkspaceNotice({ instance, languageStatus }: WorkspaceNoticeDeps): () => void {
  const say = () => {
    const outside = outsideGameFolder(instance.value);
    languageStatus(outside && `Paths are checked only against the instance, and scripts are not checked: the game also gets files from ${outside.root}, outside the workspace.`);
  };
  const subscription = instance.subscribe(say, NOTICE_READ);
  say();
  return () => { subscription.dispose(); };
}
