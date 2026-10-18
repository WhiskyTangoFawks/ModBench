import type { GameFolderSetting, Subscription } from '../instanceAdapter/instanceAdapter';

export const GAME_FOLDER_SETTING_ID = 'modbench.mods.gameFolder';

/** The game folder setting as a test fixes it: a value, and a change it never signals unless handed a hearer. */
export function fixedGameFolderSetting(
  value?: string, changed: (listener: () => void) => Subscription = () => ({ dispose: () => {} }),
): GameFolderSetting {
  return { id: GAME_FOLDER_SETTING_ID, value: () => value, changed };
}
