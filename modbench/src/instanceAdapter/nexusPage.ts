const PAGE = /^https:\/\/www\.nexusmods\.com\/([^/?#]+)\/mods\/(\d+)(?:\?tab=files&file_id=(\d+))?$/;

/** A file's page on Nexus, or a mod's when no file is named, the game named by its Nexus domain. */
export interface NexusPage {
  readonly game: string;
  readonly modId: string;
  readonly fileId: string | undefined;
}

export function parseNexusPage(text: string): NexusPage | undefined {
  const [, game, modId, fileId] = PAGE.exec(text) ?? [];
  return game === undefined || modId === undefined ? undefined : { game, modId, fileId };
}

export const formatNexusPage = ({ game, modId, fileId }: NexusPage): string =>
  `https://www.nexusmods.com/${game}/mods/${modId}${fileId === undefined ? '' : `?tab=files&file_id=${fileId}`}`;
