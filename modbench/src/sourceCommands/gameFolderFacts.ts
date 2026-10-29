import type { NotFound, RestoreFacts, UpdateManifestMod } from '../client';
import { deployedPath } from '../deployment/deployment';
import type { Depot, GameFile, GamePlace, InstanceAdapter, SourceMods } from '../instanceAdapter/instanceAdapter';

type GameAdapter = Pick<InstanceAdapter, 'gamePlaces' | 'gameRelease' | 'modOrder' | 'gameFiles' | 'gameFilesTakenBy'>;

type WireDepots = NonNullable<NonNullable<UpdateManifestMod['gameFolder']>['depots']>;

export interface NamedGameFolder {
  readonly name: string;
  readonly places: readonly [GamePlace, ...GamePlace[]];
}

export type HeldGameFiles = ReadonlyMap<GamePlace, readonly GameFile[]>;

export const NONE_HELD: HeldGameFiles = new Map();

export interface GameToHand {
  readonly takes: (mod: string) => boolean;
  readonly folder: NamedGameFolder | string;
}

// The game folder found, named by the game's release, or why a manifest cannot name it.
export async function namedGameFolder(adapter: GameAdapter, gameRelease: string): Promise<NamedGameFolder | string> {
  const [first, ...others] = await adapter.gamePlaces();
  return first === undefined ? 'the game folder was not found' : { name: gameRelease, places: [first, ...others] };
}

export async function gameToHand(adapter: GameAdapter, sourceMods: SourceMods): Promise<GameToHand> {
  const [{ modFolders }, folder] = await Promise.all([adapter.modOrder(), namedGameFolder(adapter, await adapter.gameRelease())]);
  return { folder, takes: (mod) => sourceMods.folderOf(mod) === undefined && modFolders?.find((entry) => entry.modName === mod)?.kind !== 'separator' };
}

const wireDepots = (depots: readonly Depot[], sent: boolean): { depots?: WireDepots } => (sent && depots.length > 0 ? { depots: [...depots] } : {});

export const wireGameFolder = (folder: NamedGameFolder | string, held: HeldGameFiles, withDepots: boolean): RestoreFacts['gameFolder'] => {
  if (typeof folder === 'string') return undefined;
  const { name, places: [first, ...others] } = folder;
  const elsewhere = others.flatMap((place) => {
    const files = held.get(place) ?? [];
    return files.length === 0 ? [] : [{ root: place.root, files: [...files], ...wireDepots(place.depots, withDepots) }];
  });
  return { name, root: first.root, files: [...held.get(first) ?? []], ...wireDepots(first.depots, withDepots), ...elsewhere.length === 0 ? {} : { elsewhere } };
};

export async function gameFilesOf(
  adapter: GameAdapter, { mod, folder }: { mod: string; folder: string }, game: GameToHand | undefined, installed: boolean,
): Promise<{ gameFiles: HeldGameFiles; notes: readonly string[] } | { refusal: string }> {
  if (game === undefined || !game.takes(mod)) return { gameFiles: NONE_HELD, notes: [] };
  if (typeof game.folder === 'string') {
    return { gameFiles: NONE_HELD, notes: installed ? [] : [`${game.folder}, so its manifest cannot name the game folder as its package`] };
  }
  const [inGame, ...inOthers] = await Promise.all(game.folder.places.map(async (place) => ({ place, taken: await adapter.gameFilesTakenBy(place, folder, deployedPath) })));
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

export async function namedGameFiles(
  adapter: GameAdapter, folder: NamedGameFolder | string, notFound: readonly Pick<NotFound, 'mod' | 'gameFiles'>[],
): Promise<{ found: HeldGameFiles; unreadable: (mod: string) => Record<string, string> }> {
  const found = new Map<GamePlace, Map<string, GameFile>>();
  const unreadable = new Map<string, Record<string, string>>();
  for (const { mod, gameFiles } of notFound) {
    if (gameFiles.length === 0) continue;
    if (typeof folder === 'string') {
      unreadable.set(mod, Object.fromEntries(gameFiles.map((path) => [path, folder])));
      continue;
    }
    const reasons: Record<string, string> = {};
    for (const place of folder.places) {
      const read = await adapter.gameFiles(place, gameFiles);
      Object.assign(reasons, read.unreadable, reasons);
      const foundHere = found.get(place) ?? new Map<string, GameFile>();
      for (const file of read.files) foundHere.set(file.path.toLowerCase(), file);
      found.set(place, foundHere);
    }
    unreadable.set(mod, reasons);
  }
  return { found: new Map([...found].map(([place, files]) => [place, [...files.values()]])), unreadable: (mod) => unreadable.get(mod) ?? {} };
}
