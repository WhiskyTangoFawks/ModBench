import { describe, it, expect } from 'vitest';
import { heardChanges } from '../heardChanges';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import type { PluginAddress } from '../../client';

const A: PluginAddress = { name: 'A.esp', origin: 'ModA' };

function world() {
  const calls: (PluginAddress | undefined)[] = [];
  const changed = new Set<(event: { plugin: PluginAddress }) => void>();
  const settled = new Set<(status: unknown) => void>();
  const instance = new Set<() => void>();
  const client = {
    getPluginFilePaths: (plugin?: PluginAddress) => { calls.push(plugin); return Promise.resolve([{ plugin: A, unread: [] }]); },
    getPluginProblems: () => Promise.resolve([]),
    onNotification: (_kind: 'rows-changed' | 'plugin-changed', listener: (event: { plugin: PluginAddress }) => void) => { changed.add(listener); return () => { changed.delete(listener); }; },
    onLoadOrderSettled: (listener: (status: unknown) => void) => { settled.add(listener); return () => { settled.delete(listener); }; },
  };
  const asker = problemsAsker(client);
  const heard: (PluginAddress | undefined)[] = [];
  const subscribe = (listener: () => void) => { instance.add(listener); return { dispose: () => { instance.delete(listener); } }; };
  const stop = heardChanges({ asker, instance: { subscribe } }, (plugin) => { heard.push(plugin); });
  return {
    asker, calls, heard, stop,
    instanceChanges: () => { for (const listener of instance) listener(); },
    pluginChanges: () => { for (const listener of changed) listener({ plugin: A }); },
    settles: () => { for (const listener of settled) listener({}); },
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

    expect([w.heard, w.calls]).toEqual([[plugin], [undefined, undefined]]);
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
