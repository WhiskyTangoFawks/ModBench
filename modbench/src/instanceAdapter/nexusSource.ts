import type { InstalledFileId } from './instanceAdapter';

/** A Nexus mod and the files installed from it, the game named by its Nexus domain. */
export interface NexusSource {
  readonly game: string;
  readonly modId: string | undefined;
  readonly files: readonly InstalledFileId[];
}

export function parseNexusSource(text: string): NexusSource | undefined {
  const [head = '', ...pairs] = text.split(';');
  const [scheme, game, modId] = head.split(':');
  if (scheme !== 'nexus' || !game) return undefined;
  return {
    game,
    modId: modId || undefined,
    files: pairs.map((pair) => {
      const [nexusId = '', fileId = ''] = pair.split(':');
      return { nexusId, fileId };
    }),
  };
}

export const formatNexusSource = ({ game, modId, files }: NexusSource): string =>
  `nexus:${game}:${modId ?? ''}${files.map(({ nexusId, fileId }) => `;${nexusId}:${fileId}`).join('')}`;
