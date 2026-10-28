import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { realPathOf } from './pathWithin';

/** The game folder, then the Steam install when it is another folder; the Steam install's depots ride the place that is it. */
export async function gamePlacesOf(game: GameFolder, steam: SteamInstall | undefined): Promise<readonly GamePlace[]> {
  if (game.kind !== 'found') return [];
  const gamePlace = { dataFolder: game.dataFolder, depots: [], depotProblems: [] };
  if (steam === undefined) return [gamePlace];
  const { dataFolder, depots, depotProblems } = steam;
  if (await realPathOf(dataFolder) === await realPathOf(game.dataFolder)) return [{ dataFolder: game.dataFolder, depots, depotProblems }];
  return [gamePlace, { dataFolder, depots, depotProblems }];
}
