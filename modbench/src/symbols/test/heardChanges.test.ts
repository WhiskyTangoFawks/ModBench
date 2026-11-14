import { describe, it, expect } from 'vitest';
import { heardChanges } from '../heardChanges';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import type { PluginAddress } from '../../client';

const A: PluginAddress = { name: 'A.esp', origin: 'ModA' };

function world() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginFilePaths', [{ plugin: A, paths: [], scripts: [], unread: [] }]);
  const asker = problemsAsker(client);
  const instance = new Set<() => void>();
  const heard: (PluginAddress | undefined)[] = [];
  const subscribe = (listener: () => void) => { instance.add(listener); return { dispose: () => { instance.delete(listener); } }; };
  const stop = heardChanges({ asker, instance: { subscribe } }, (plugin) => { heard.push(plugin); });
  const asked = () => client.calls.filter(({ method }) => method === 'getPluginFilePaths').length;
  return {
    asker, heard, stop, asked,
    instanceChanges: () => { for (const listener of instance) listener(); },
    pluginChanges: () => { client.emit({ kind: 'plugin-changed', plugin: A.name, origin: A.origin, keys: [], sequence: 1 }); },
    settles: () => { client.emit(loadOrderStatusEventFixture({ state: 'Ready', conflictsComputed: true, version: 1 })); },
  };
}

type World = ReturnType<typeof world>;

describe('heardChanges', () => {
  it.each([
    ['the instance changes', (w: World) => { w.instanceChanges(); }, undefined],
    ['the load order settles', (w: World) => { w.settles(); }, undefined],
    ['a plugin changes', (w: World) => { w.pluginChanges(); }, A],
  ])('tells its listener when %s, after the asker dropped what it held', async (_when, change, plugin) => {
    const w = world();
    await w.asker.getPluginFilePaths();

    change(w);
    await w.asker.getPluginFilePaths();

    expect([w.heard, w.asked()]).toEqual([[plugin], 2]);
  });

  it('hears nothing once stopped', () => {
    const w = world();

    w.stop();
    w.instanceChanges();
    w.settles();
    w.pluginChanges();

    expect(w.heard).toEqual([]);
  });
});
