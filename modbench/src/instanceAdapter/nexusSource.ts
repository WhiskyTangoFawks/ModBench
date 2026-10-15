import type { InstalledFileId } from './instanceAdapter';

/** A Nexus mod and the files installed from it, the game named by its Nexus domain. */
export interface NexusSource {
  readonly game: string;
  readonly modId: string | undefined;
  readonly files: readonly InstalledFileId[];
}

export const formatNexusSource = ({ game, modId, files }: NexusSource): string =>
  `nexus:${game}:${modId ?? ''}${files.map(({ nexusId, fileId }) => `;${nexusId}:${fileId}`).join('')}`;
