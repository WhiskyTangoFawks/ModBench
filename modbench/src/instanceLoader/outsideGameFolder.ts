import type { FoundGameFolder } from '../instanceAdapter/instanceAdapter';
import type { InstanceValue } from './instance';

/** The game folder the instance found, when the workspace does not hold it: its files are never a definition (ADR-0001). */
export function outsideGameFolder({ gameFolder, gameFolderInWorkspace }: Pick<InstanceValue, 'gameFolder' | 'gameFolderInWorkspace'>): FoundGameFolder | undefined {
  return gameFolder.kind === 'found' && !gameFolderInWorkspace ? gameFolder : undefined;
}
