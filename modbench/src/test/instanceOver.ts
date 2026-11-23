import { Instance } from '../instanceLoader/instance';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The Instance loader over `adapter`: what a box's test stands up to see which changes it is told of. */
export const instanceOver = (adapter: InstanceAdapter): Instance => new Instance({
  adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: quiet, medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
});
