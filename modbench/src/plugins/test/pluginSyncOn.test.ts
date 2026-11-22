import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { pluginSyncOn } from '../pluginSync';
import { handingOneChange } from '../../drivingLib/writingGesture';
import { ambientWrites, collectingWrites } from '../../instanceLoader/ambientWrites';
import { WrittenFiles } from '../../instanceLoader/writtenFiles';
import { instanceOver } from '../../test/instanceOver';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';

const channel = { error: () => undefined, info: () => undefined };

function instanceHeard() {
  let subscriber!: () => Promise<void>;
  const refresh = vi.fn((wrote?: readonly string[]) => { void wrote; return Promise.resolve(); });
  const instance = { refresh, subscribe: (s: () => Promise<void>) => { subscriber = s; return { dispose: () => undefined }; } };
  const hears = () => subscriber();
  return { instance, refresh, hears };
}

describe('plugin sync on the instance', () => {
  it('holds the value that landed until the line it wrote is read back', async () => {
    const { instance, refresh, hears } = instanceHeard();
    let readBack!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => { readBack = resolve; }));
    pluginSyncOn({
      instance, channel,
      syncPlugins: () => { ambientWrites.name(['/profile/plugins.txt']); return Promise.resolve({ applied: true, wrote: true, added: [], dropped: [] }); },
    });

    let settled = false;
    const heard = hears().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ refreshed: refresh.mock.calls, settled }).toEqual({ refreshed: [[['/profile/plugins.txt']]], settled: false });

    readBack();
    await heard;
    expect(settled).toBe(true);
  });

  it('never runs a sync that waited for a change and was disposed meanwhile', async () => {
    const { instance, hears } = instanceHeard();
    const syncPlugins = vi.fn(() => Promise.resolve({ applied: true as const, wrote: false, added: [], dropped: [] }));
    const syncing = pluginSyncOn({ instance, channel, syncPlugins });

    await handingOneChange(instance, async () => {
      await hears();
      syncing.dispose();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(syncPlugins).not.toHaveBeenCalled();
  });

  it('reads nothing back when the sync wrote nothing', async () => {
    const { instance, refresh, hears } = instanceHeard();
    pluginSyncOn({ instance, channel, syncPlugins: () => Promise.resolve({ applied: true, wrote: false, added: [], dropped: [] }) });

    await hears();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads nothing back when what it wrote told the Instance loader', async () => {
    const { instance, refresh, hears } = instanceHeard();
    pluginSyncOn({ instance, channel, syncPlugins: () => Promise.resolve({ applied: true, wrote: true, added: [], dropped: [] }) });

    await hears();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads the whole disk back when its write left the files unnamed', async () => {
    const { instance, refresh, hears } = instanceHeard();
    pluginSyncOn({
      instance, channel,
      syncPlugins: () => { ambientWrites.leaveUnnamed(); return Promise.resolve({ applied: true, wrote: true, added: [], dropped: [] }); },
    });

    await hears();

    expect(refresh.mock.calls).toEqual([[undefined]]);
  });

  it('reads back what its own run wrote when a later run, overlapping it, wrote nothing', async () => {
    const { instance, refresh, hears } = instanceHeard();
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const firstRun = async () => { await gate; ambientWrites.name(['/profile/plugins.txt']); return { applied: true as const, wrote: true, added: [], dropped: [] }; };
    const later = () => Promise.resolve({ applied: true as const, wrote: false, added: [], dropped: [] });
    let called = 0;
    pluginSyncOn({ instance, channel, syncPlugins: () => (called++ === 0 ? firstRun() : later()) });

    const first = hears();
    await hears();
    finishFirst();
    await first;

    expect(refresh.mock.calls).toEqual([[['/profile/plugins.txt']]]);
  });

  it('leaves a collector around the call without the files it wrote', async () => {
    const { instance, hears } = instanceHeard();
    pluginSyncOn({
      instance, channel,
      syncPlugins: () => { ambientWrites.name(['/profile/plugins.txt']); return Promise.resolve({ applied: true, wrote: true, added: [], dropped: [] }); },
    });
    const around = new WrittenFiles();

    await collectingWrites(around, hears);

    expect(around.named).toEqual([]);
  });

  it('runs on a change to a plugin file, its plugin source or a manifest, whose masters and names it reads, and on no change to another file', async () => {
    const instance = instanceOver(fakeInstanceAdapter(readingFixture({ sourceModFolders: new Map([['A', '/instance/source/Repo']]) })).adapter);
    const syncPlugins = vi.fn(() => Promise.resolve({ applied: true as const, wrote: false, added: [], dropped: [] }));
    const { pluginSync } = pluginSyncOn({ instance, channel, syncPlugins });

    await instance.refresh();
    await instance.refresh(['/instance/mods/A/textures/a.dds']);
    await instance.refresh(['/instance/mods/A/A.esp']);
    await instance.refresh(['/instance/mods/A/A.manifest.json']);
    await instance.refresh(['/instance/source/Repo/plugin-source/A.esp/records.yaml']);
    await pluginSync.settled();

    instance.dispose();
    expect(syncPlugins).toHaveBeenCalledTimes(4);
  });
});
