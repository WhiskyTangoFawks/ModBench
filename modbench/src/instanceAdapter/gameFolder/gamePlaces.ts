import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { isWithin } from './pathWithin';

const sameFolder = async (one: string, other: string): Promise<boolean> => await isWithin(one, other) && await isWithin(other, one);

export async function gamePlacesOf(game: GameFolder, steam: SteamInstall | undefined): Promise<readonly GamePlace[]> {
  if (game.kind !== 'found') return [];
  const gamePlace = { root: game.root, dataFolder: game.dataFolder, depots: [], depotProblems: [] };
  if (steam === undefined) return [gamePlace];
  const { root, dataFolder, depots, depotProblems } = steam;
  if (await sameFolder(game.root, root)) return [{ ...gamePlace, depots, depotProblems }];
  // A Data folder linked to the Steam install's holds the files its depots do, and the game folder's root its own.
  const dataElsewhere = await sameFolder(game.dataFolder, dataFolder);
  return [dataElsewhere ? { ...gamePlace, dataFolder: undefined } : gamePlace, { root, dataFolder, depots, depotProblems }];
}
