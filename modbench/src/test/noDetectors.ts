import type { GameDetectors } from '../instanceAdapter/gameDirectory';

export const NO_DETECTORS: GameDetectors = {
  paths: () => Promise.resolve(null),
  winePrefix: () => Promise.resolve(null),
  documents: () => Promise.reject(new Error('no known folder')),
};
