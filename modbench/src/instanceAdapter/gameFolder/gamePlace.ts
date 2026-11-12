import type { GameFolder, GamePlace, SteamInstall } from '../instanceAdapter';
import { isWithin } from './pathWithin';

const sameFolder = async (one: string, other: string): Promise<boolean> => await isWithin(one, other) && await isWithin(other, one);

export async function gamePlaceOf(game: GameFolder, steam: SteamInstall | undefined): Promise<GamePlace | undefined> {
  if (game.kind !== 'found') return undefined;
  if (steam === undefined) return { root: game.root, depots: [], depotProblems: [] };
  const { steamApp, depots, depotProblems } = steam;
  const steamRoot = await sameFolder(game.root, steam.root) ? {} : { steamRoot: steam.root };
  return { root: game.root, ...steamRoot, steamApp, depots, depotProblems };
}
