import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { isWithin } from './pathWithin';

export async function gamePlacesOf(game: GameFolder, steam: SteamInstall | undefined): Promise<readonly GamePlace[]> {
  if (game.kind !== 'found') return [];
  const gamePlace = { dataFolder: game.dataFolder, depots: [], depotProblems: [] };
  if (steam === undefined) return [gamePlace];
  const { dataFolder, depots, depotProblems } = steam;
  const sameFolder = await isWithin(game.dataFolder, dataFolder) && await isWithin(dataFolder, game.dataFolder);
  return sameFolder ? [{ ...gamePlace, depots, depotProblems }] : [gamePlace, { dataFolder, depots, depotProblems }];
}
