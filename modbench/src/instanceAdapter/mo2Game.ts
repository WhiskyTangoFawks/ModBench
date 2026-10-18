import { gameReleaseForGame } from '../tables/gamePaths';
import { readGameName } from './codecs/modOrganizerIni';

// The tables key each release on the game's name as `gameName=` spells it.
export const gameOfSettings = (iniText: string) => {
  const gameName = readGameName(iniText);
  return { gameName, gameRelease: gameReleaseForGame(gameName) };
};
