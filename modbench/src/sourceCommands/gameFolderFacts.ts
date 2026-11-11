import type { GamePlace, InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import type { SourceMods } from '../manifestAdapter/manifestAdapter';
import type { GameHeld } from './manifestBuilder';

type GameAdapter = Pick<InstanceAdapter, 'gamePlace' | 'gameRelease' | 'gameFiles' | 'gameFilesTakenBy'>;

export interface NamedGameFolder {
  readonly name: string;
  readonly place: GamePlace;
}

export type HeldGameFiles = GameHeld['files'];

export const NONE_HELD: HeldGameFiles = [];

export interface GameToHand {
  readonly takes: (mod: string) => boolean;
  readonly folder: NamedGameFolder | string;
}

// The game folder found, named by the game's release, or why a manifest cannot name it.
export async function namedGameFolder(adapter: Pick<InstanceAdapter, 'gamePlace'>, gameRelease: string): Promise<NamedGameFolder | string> {
  const place = await adapter.gamePlace();
  return place === undefined ? 'the game folder was not found' : { name: gameRelease, place };
}

export async function gameToHand(adapter: GameAdapter, sourceMods: SourceMods): Promise<GameToHand> {
  const folder = await namedGameFolder(adapter, await adapter.gameRelease());
  return { folder, takes: (mod) => sourceMods.folderOf(mod) === undefined };
}

/** The game folder with the files it holds of a mod's, none when the game folder was not found. */
export function gameHeld(folder: NamedGameFolder | string, files: HeldGameFiles): GameHeld | undefined {
  if (typeof folder === 'string') return undefined;
  const { depots, steamApp } = folder.place;
  return { files, depots, ...steamApp === undefined ? {} : { steamApp } };
}

export async function gameFilesOf(
  adapter: GameAdapter, { mod, folder }: { mod: string; folder: string }, game: GameToHand | undefined, installed: boolean,
): Promise<{ gameFiles: HeldGameFiles; notes: readonly string[] } | { refusal: string }> {
  if (game === undefined || !game.takes(mod)) return { gameFiles: NONE_HELD, notes: [] };
  if (typeof game.folder === 'string') {
    return { gameFiles: NONE_HELD, notes: installed ? [] : [`${game.folder}, so its manifest cannot name the game folder as its package`] };
  }
  const taken = await adapter.gameFilesTakenBy(game.folder.place, folder);
  if (taken.kind === 'unreadable') {
    return installed ? { gameFiles: NONE_HELD, notes: [`the game files its files may be could not be read: ${taken.reason}`] } : { refusal: taken.reason };
  }
  return { gameFiles: taken.answer.gameFiles, notes: taken.answer.notes };
}
