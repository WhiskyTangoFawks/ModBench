import { describe, it, expect, afterEach, vi } from 'vitest';
import { fakeVscodeModule } from './mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { rm } from 'node:fs/promises';
import { Instance } from '../instanceLoader/instance';
import { writesToldTo } from '../repositoriesLib/writeNaming';
import { instanceCommands } from '../instanceCommands/instanceCommands';
import { InMemoryMEditClient } from '../client/test/InMemoryMEditClient';
import { fakeWorkspace } from './fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from './gameFolderSetting';
import { cloneCorpusFixture } from './mo2/corpusFixture';
import { adapterOver } from './mo2/adapterOver';

let root: string | undefined;
let instance: Instance | undefined;

afterEach(async () => {
  instance?.dispose();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('switch profile over the real adapter', () => {
  it('leaves the instance value on the new profile, its mod list read, when the write returns', async () => {
    root = cloneCorpusFixture();
    const adapter = adapterOver(root);
    instance = new Instance({
      adapter, gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
    });
    writesToldTo(instance);
    await instance.refresh();
    const before = instance.value.activeProfile;

    await instanceCommands({ adapter, client: new InMemoryMEditClient(), instanceRoot: root }).switchProfile('Secondary');

    expect({ before, now: instance.value.activeProfile, mods: instance.value.mods.map((mod) => mod.name) }).toEqual({
      before: 'Default', now: 'Secondary', mods: ['Unofficial Fallout 4 Patch', 'Harder VATS'],
    });
  });
});
