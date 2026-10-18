import { gameReleaseForGame } from '../tables/gamePaths';
import { readGameName } from './codecs/modOrganizerIni';

// The tables key each release on the game's name as `gameName=` spells it. A game the tables hold no release for is
// refused: Modbench writes the asterisk format of `plugins.txt`, which only the games in the tables read.
export const gameOfSettings = (iniText: string) => {
  const gameName = readGameName(iniText);
  const gameRelease = gameReleaseForGame(gameName);
  if (gameRelease === undefined) throw new Error(`Modbench does not support ${gameName}`);
  return { gameName, gameRelease };
};
