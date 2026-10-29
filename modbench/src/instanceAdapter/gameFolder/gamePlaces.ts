import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { isWithin } from './pathWithin';

export async function gamePlacesOf(game: GameFolder, steam: SteamInstall | undefined): Promise<readonly GamePlace[]> {
  if (game.kind !== 'found') return [];
  const gamePlace = { root: game.root, depots: [], depotProblems: [] };
  if (steam === undefined) return [gamePlace];
  const { root, depots, depotProblems } = steam;
  const sameFolder = await isWithin(game.root, root) && await isWithin(root, game.root);
  return sameFolder ? [{ ...gamePlace, depots, depotProblems }] : [gamePlace, { root, depots, depotProblems }];
}
