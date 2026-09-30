// Every per-game fact needed to find an install and speak to Nexus, keyed by Mutagen's
// GameRelease, and where a plugin sits in an install.

import { join } from 'node:path';

export interface GamePathInfo {
  /** The game's own name. */
  readonly gameName: string;
  /** The Nexus slug — the {game} segment of nexusmods.com/{game}/mods/{id}. */
  readonly nexusSlug: string;
  /** Steam's numeric app id, when the release ships on Steam. Needed to find which Steam
   *  library holds the install (`libraryfolders.vdf`) and its Proton prefix. Absent for a
   *  release the table only knows the Nexus slug for. */
  readonly steamAppId?: string;
  /** The `steamapps/common/<name>` folder holding the install. Absent alongside `steamAppId`. */
  readonly steamFolderName?: string;
}

// Only Fallout 4 carries Steam autodetection facts today — a fixture choice, not a platform lock.
const GAME_PATHS: Record<string, GamePathInfo> = {
  Fallout4: { gameName: 'Fallout 4', nexusSlug: 'fallout4', steamAppId: '377160', steamFolderName: 'Fallout 4' },
  Fallout4VR: { gameName: 'Fallout 4 VR', nexusSlug: 'fallout4' },
  Fallout3: { gameName: 'Fallout 3', nexusSlug: 'fallout3' },
  FalloutNV: { gameName: 'Fallout New Vegas', nexusSlug: 'newvegas' },
  SkyrimLE: { gameName: 'Skyrim', nexusSlug: 'skyrim' },
  SkyrimSE: { gameName: 'Skyrim Special Edition', nexusSlug: 'skyrimspecialedition' },
  SkyrimVR: { gameName: 'Skyrim VR', nexusSlug: 'skyrimspecialedition' },
  EnderalLE: { gameName: 'Enderal', nexusSlug: 'enderal' },
  Oblivion: { gameName: 'Oblivion', nexusSlug: 'oblivion' },
};

// Rebuilt from the table above so the two directions can never disagree. Morrowind resolves to no
// entry: Mutagen has no release for it.
const RELEASE_BY_GAME_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(GAME_PATHS).map(([release, info]) => [info.gameName, release]),
);

/** Mutagen's release name for a game's own name, `undefined` when the table holds none. Never a
 *  guess: a wrong release has the backend answer confidently about another game. */
export function gameReleaseForGame(gameName: string): string | undefined {
  return RELEASE_BY_GAME_NAME.get(gameName);
}

/** Nexus slug for a game's own name; unknown games fall back to the lowercased,
 *  space-stripped name (a best guess that matches most Nexus domains). */
export function nexusSlugForGame(gameName: string): string {
  const release = RELEASE_BY_GAME_NAME.get(gameName);
  const info = release ? GAME_PATHS[release] : undefined;
  return info?.nexusSlug ?? gameName.toLowerCase().replace(/\s+/g, '');
}

/** The install-location facts for a release, or `undefined` when the table holds none for it —
 *  the autodetector's signal to give up rather than guess a folder. */
export function gamePathInfoForRelease(release: string): GamePathInfo | undefined {
  return GAME_PATHS[release];
}

/** A game folder as plain data: found, with its Data folder, or not found. */
export type GameFolderData = { readonly kind: 'found'; readonly dataFolder: string } | { readonly kind: 'notFound' };

/** The Data folder of a game folder found, undefined when it was not. */
export function dataFolderOf(folder: GameFolderData): string | undefined {
  return folder.kind === 'found' ? folder.dataFolder : undefined;
}

/** A file at the root of the Data folder of a game folder found, undefined when it was not. */
export function dataFolderFile(folder: GameFolderData, name: string): string | undefined {
  const dataFolder = dataFolderOf(folder);
  return dataFolder === undefined ? undefined : join(dataFolder, name);
}
