import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { isWithin } from './pathWithin';

const sameFolder = async (one: string, other: string): Promise<boolean> => await isWithin(one, other) && await isWithin(other, one);

export async function gamePlacesOf(game: GameFolder, steam: SteamInstall | undefined): Promise<readonly GamePlace[]> {
  if (game.kind !== 'found') return [];
  if (steam !== undefined && await sameFolder(game.root, steam.root)) {
    return [{ root: game.root, steamApp: steam.steamApp, depots: steam.depots, depotProblems: steam.depotProblems }];
  }
  return [{ root: game.root, depots: [], depotProblems: [] }];
}
