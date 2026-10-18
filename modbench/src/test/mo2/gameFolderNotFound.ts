import type { GameFolder } from '../../instanceLoader/instance';

/** The Instance adapter's answer when every place it looked came up empty. */
export const GAME_FOLDER_NOT_FOUND: GameFolder = {
  kind: 'notFound',
  setting: 'modbench.mods.gameFolder',
  looked: [
    { place: 'the game folder setting, modbench.mods.gameFolder', answer: 'not set' },
    { place: "ModOrganizer.ini's gamePath", answer: 'not set' },
    { place: 'the Steam install', answer: 'the game is in no Steam library' },
  ],
};
