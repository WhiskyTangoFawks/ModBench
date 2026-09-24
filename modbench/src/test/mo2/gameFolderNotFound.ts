import type { GameDirectoryResolver } from '../../instanceAdapter/gameDirectory';
import type { GameFolder } from '../../instanceLoader/instance';

/** The Instance adapter's answer when every place it looked came up empty. */
export const GAME_FOLDER_NOT_FOUND: GameFolder = {
  kind: 'notFound',
  setting: 'modbench.mods.gameDirectory',
  looked: [
    { place: 'the game folder setting, modbench.mods.gameDirectory', answer: 'not set' },
    { place: "ModOrganizer.ini's gamePath", answer: 'not set' },
    { place: 'the Steam install', answer: 'the game is in no Steam library' },
  ],
};

export const resolvesNotFound: GameDirectoryResolver = () => Promise.resolve(GAME_FOLDER_NOT_FOUND);
