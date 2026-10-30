import type { GamePlace, InstanceAdapter, SourceMods } from '../instanceAdapter/instanceAdapter';
import type { GameHeld, GamePlaceHeld } from './manifestBuilder';

type GameAdapter = Pick<InstanceAdapter, 'gamePlaces' | 'gameRelease' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy'>;

export interface NamedGameFolder {
  readonly name: string;
  readonly places: readonly [GamePlace, ...GamePlace[]];
}

export type HeldGameFiles = ReadonlyMap<GamePlace, GamePlaceHeld['files']>;

export const NONE_HELD: HeldGameFiles = new Map();

export interface GameToHand {
  readonly takes: (mod: string) => boolean;
  readonly folder: NamedGameFolder | string;
}

// The game folder found, named by the game's release, or why a manifest cannot name it.
export async function namedGameFolder(adapter: Pick<InstanceAdapter, 'gamePlaces'>, gameRelease: string): Promise<NamedGameFolder | string> {
  const [first, ...others] = await adapter.gamePlaces();
  return first === undefined ? 'the game folder was not found' : { name: gameRelease, places: [first, ...others] };
}

export async function gameToHand(adapter: GameAdapter, sourceMods: SourceMods): Promise<GameToHand> {
  const [{ modFolders }, folder] = await Promise.all([adapter.modOrder(), namedGameFolder(adapter, await adapter.gameRelease())]);
  return { folder, takes: (mod) => sourceMods.folderOf(mod) === undefined && modFolders?.find((entry) => entry.modName === mod)?.kind !== 'separator' };
}

/** The game folder with the files each place holds of a mod's, none when the game folder was not found. */
export function gameHeld(folder: NamedGameFolder | string, held: HeldGameFiles): GameHeld | undefined {
  if (typeof folder === 'string') return undefined;
  const placeHeld = (place: GamePlace): GamePlaceHeld => ({ files: held.get(place) ?? [], depots: place.depots });
  const [first, ...others] = folder.places;
  return { name: folder.name, places: [placeHeld(first), ...others.map(placeHeld)] };
}

export async function gameFilesOf(
  adapter: GameAdapter, { mod, folder }: { mod: string; folder: string }, game: GameToHand | undefined, installed: boolean,
): Promise<{ gameFiles: HeldGameFiles; notes: readonly string[] } | { refusal: string }> {
  if (game === undefined || !game.takes(mod)) return { gameFiles: NONE_HELD, notes: [] };
  if (typeof game.folder === 'string') {
    return { gameFiles: NONE_HELD, notes: installed ? [] : [`${game.folder}, so its manifest cannot name the game folder as its package`] };
  }
  const [inGame, ...inOthers] = await Promise.all(game.folder.places.map(async (place) => ({ place, taken: await adapter.gameFilesTakenBy(place, folder) })));
  if (inGame === undefined) return { gameFiles: NONE_HELD, notes: [] };
  if (inGame.taken.kind === 'unreadable') {
    return installed ? { gameFiles: NONE_HELD, notes: [`the game files its files may be could not be read: ${inGame.taken.reason}`] } : { refusal: inGame.taken.reason };
  }
  const held = new Map([[inGame.place, inGame.taken.answer.gameFiles]]);
  const notes = new Set(inGame.taken.answer.notes);
  for (const { place, taken } of inOthers) {
    if (taken.kind === 'unreadable') {
      notes.add(`the game files in ${place.root} could not be read: ${taken.reason}`);
    } else {
      held.set(place, taken.answer.gameFiles);
      for (const note of taken.answer.notes) notes.add(note);
    }
  }
  return { gameFiles: held, notes: [...notes] };
}

