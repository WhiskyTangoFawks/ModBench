import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { pluginsOver } from './pluginsOver';
import { handingOneChange } from '../../drivingLib/writingGesture';
import { ambientWrites, collectingWrites } from '../../instanceLoader/ambientWrites';
import { WrittenFiles } from '../../instanceLoader/writtenFiles';
import type { PluginSyncRun } from '../../pluginCommands/plugins';
import { FakeInstance } from '../../test/mo2/fakeInstance';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';
import { instanceOver } from '../../test/instanceOver';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { settled as until } from '../../test/eventually';

type PluginSyncResult = Awaited<ReturnType<PluginSyncRun>>;
const WROTE: PluginSyncResult = { applied: true, wrote: true, added: [], dropped: [] };
const UNCHANGED: PluginSyncResult = { applied: true, wrote: false, added: [], dropped: [] };
const PLUGINS_TXT = '/profile/plugins.txt';
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function syncing(syncPlugins: () => Promise<PluginSyncResult>) {
  const instance = new FakeInstance(instanceValueFixture());
  const runs: unknown[] = [];
  const subscribe = FakeInstance.prototype.subscribe.bind(instance);
  const refresh = vi.fn((_wrote?: readonly string[]) => Promise.resolve());
  Object.assign(instance, {
    refresh,
    subscribe: (...[subscriber, concerns]: Parameters<FakeInstance['subscribe']>) =>
      subscribe((...told) => { const run = subscriber(...told); runs.push(run); return run; }, concerns),
  });
  const synced = vi.fn(syncPlugins);
  const made = pluginsOver({ instance, syncPlugins: synced });
  const hears = () => {
    const from = runs.length;
    instance.publish(instance.value);
    return Promise.all(runs.slice(from));
  };
  return { ...made, refresh, hears, synced };
}

const writing = (named: () => void) => () => { named(); return Promise.resolve(WROTE); };

describe('the plugin sync command', () => {
  it('is modbench.plugin.sync, and runs the plugin sync', async () => {
    const { synced } = syncing(() => Promise.resolve(UNCHANGED));

    await host.run('modbench.plugin.sync');

    expect(synced).toHaveBeenCalledTimes(1);
  });
});

describe('plugin sync on the instance', () => {
  it('holds the value that landed until the line it wrote is read back', async () => {
    const { refresh, hears } = syncing(writing(() => { ambientWrites.name([PLUGINS_TXT]); }));
    let readBack!: () => void;
    refresh.mockImplementation(() => new Promise<void>((resolve) => { readBack = resolve; }));

    let landed = false;
    const heard = hears().then(() => { landed = true; });
    await until(() => { expect(refresh.mock.calls).toEqual([[[PLUGINS_TXT]]]); });
    await settle();
    expect(landed).toBe(false);

    readBack();
    await heard;
    expect(landed).toBe(true);
  });

  it('never runs a sync that waited for a change and was disposed meanwhile', async () => {
    const { instance, hears, synced, dispose } = syncing(() => Promise.resolve(UNCHANGED));

    await handingOneChange(instance, async () => {
      await hears();
      dispose();
    });
    await settle();

    expect(synced).not.toHaveBeenCalled();
  });

  it.each([
    ['the sync wrote nothing', () => Promise.resolve(UNCHANGED)],
    ['what it wrote told the Instance loader', () => Promise.resolve(WROTE)],
  ])('reads nothing back when %s', async (_case, syncPlugins) => {
    const { refresh, hears } = syncing(syncPlugins);

    await hears();

    expect(refresh).not.toHaveBeenCalled();
  });

  it('reads the whole disk back when its write left the files unnamed', async () => {
    const { refresh, hears } = syncing(writing(() => { ambientWrites.leaveUnnamed(); }));

    await hears();

    expect(refresh.mock.calls).toEqual([[undefined]]);
  });

  it('reads back what its own run wrote when a later run, overlapping it, wrote nothing', async () => {
    let finishFirst!: () => void;
    const gate = new Promise<void>((resolve) => { finishFirst = resolve; });
    let called = 0;
    const { refresh, hears } = syncing(async () => {
      if (called++ > 0) return UNCHANGED;
      await gate;
      ambientWrites.name([PLUGINS_TXT]);
      return WROTE;
    });

    const first = hears();
    await hears();
    finishFirst();
    await first;

    expect(refresh.mock.calls).toEqual([[[PLUGINS_TXT]]]);
  });

  it('leaves a collector around the call without the files it wrote', async () => {
    const { hears } = syncing(writing(() => { ambientWrites.name([PLUGINS_TXT]); }));
    const around = new WrittenFiles();

    await collectingWrites(around, hears);

    expect(around.named).toEqual([]);
  });

  it('runs on a change to a plugin file, its plugin source or a manifest, whose masters and names it reads, and on no change to another file', async () => {
    const instance = instanceOver(fakeInstanceAdapter(readingFixture({ sourceModFolders: new Map([['A', '/instance/source/Repo']]) })).adapter);
    const syncPlugins = vi.fn(() => Promise.resolve(UNCHANGED));
    pluginsOver({ instance, syncPlugins });

    await instance.refresh();
    await instance.refresh(['/instance/mods/A/textures/a.dds']);
    await instance.refresh(['/instance/mods/A/A.esp']);
    await instance.refresh(['/instance/mods/A/A.manifest.json']);
    await instance.refresh(['/instance/source/Repo/plugin-source/A.esp/records.yaml']);
    await until(() => { expect(syncPlugins).toHaveBeenCalledTimes(4); });
    await settle();

    instance.dispose();
    expect(syncPlugins).toHaveBeenCalledTimes(4);
  });
});
