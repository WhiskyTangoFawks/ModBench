import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('vscode', () => ({}));

import { modSyncOn } from '../modSync';
import { Instance } from '../../instanceLoader/instance';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeWorkspace } from '../../test/fakeWorkspace';
import { GAME_FOLDER_SETTING_ID } from '../../test/gameFolderSetting';

const MODLIST = '/instance/profiles/Default/modlist.txt';
const instances: Instance[] = [];

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

function instanceOver(): Instance {
  const instance = new Instance({
    adapter: fakeInstanceAdapter(readingFixture({ mods: [{ kind: 'mod', name: 'A', enabled: true }] })).adapter,
    gameFolderSettingId: GAME_FOLDER_SETTING_ID, log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    medit: new InMemoryMEditClient(), workspace: fakeWorkspace(),
  });
  instances.push(instance);
  return instance;
}

describe('mod sync on the instance', () => {
  it('holds the read that started it until it has written, as a gesture that writes ends once what it wrote stands', async () => {
    const instance = instanceOver();
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const syncStarted = new Promise<void>((resolve) => { started = resolve; });
    modSyncOn({
      instance, channel: { error: () => undefined, info: () => undefined },
      syncMods: async () => {
        started();
        await released;
        order.push('written');
        return { applied: true, added: [], dropped: [] };
      },
    });

    const refreshed = instance.refresh().then(() => { order.push('read settled'); });
    await syncStarted;
    await instance.told([MODLIST]);
    expect(order).toEqual([]);
    release();
    await refreshed;

    expect(order[0]).toBe('written');
  });

  it('tries a sync that failed again at each value until one lands, though mod order and the mod folders are as they were', async () => {
    const instance = instanceOver();
    let runs = 0;
    const { modSync } = modSyncOn({
      instance, channel: { error: () => undefined, info: () => undefined },
      syncMods: () => Promise.resolve(++runs === 1 ? { applied: false, refusal: 'EBUSY' } : { applied: true, added: [], dropped: [] }),
    });

    for (let read = 0; read < 3; read++) {
      await instance.refresh([MODLIST]);
      await modSync.settled();
    }

    expect(runs).toBe(2);
  });
});
