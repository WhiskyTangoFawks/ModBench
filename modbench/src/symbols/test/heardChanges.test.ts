import { describe, it, expect } from 'vitest';
import { heardChanges } from '../heardChanges';
import { problemsAsker } from '../../drivingLib/problemsAsker';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import type { PluginAddress } from '../../client';
import { holdsLoadOrder, changeNamesPlugin } from '../../client/test/says';
import { instanceOver } from '../../test/instanceOver';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';

const A: PluginAddress = { name: 'A.esp', origin: 'ModA' };

function world() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginFilePaths', [{ plugin: A, paths: [], scripts: [], unread: [] }]);
  const asker = problemsAsker(client);
  const instance = new Set<() => void>();
  const heard: (PluginAddress | undefined)[] = [];
  const subscribe = (listener: () => void) => { instance.add(listener); return { dispose: () => { instance.delete(listener); } }; };
  const stop = heardChanges({ asker, instance: { subscribe }, facts: {} }, (plugin) => { heard.push(plugin); });
  const asked = () => client.calls.filter(({ method }) => method === 'getPluginFilePaths').length;
  return {
    asker, heard, stop, asked,
    instanceChanges: () => { for (const listener of instance) listener(); },
    pluginChanges: () => { changeNamesPlugin(client, { name: A.name, origin: A.origin }); },
    settles: () => { holdsLoadOrder(client, { version: 1 }); },
  };
}

type World = ReturnType<typeof world>;

describe('heardChanges', () => {
  it.each([
    ['the instance changes', (w: World) => { w.instanceChanges(); }, [undefined]],
    ['the load order settles, which says everything changed', (w: World) => { w.settles(); }, [undefined]],
    ['a plugin changes', (w: World) => { w.pluginChanges(); }, [A]],
  ])('tells its listener when %s, after the asker dropped what it held', async (_when, change, plugins) => {
    const w = world();
    await w.asker.getPluginFilePaths();

    change(w);
    await w.asker.getPluginFilePaths();

    expect([w.heard, w.asked()]).toEqual([plugins, 2]);
  });

  it('hears nothing once stopped', () => {
    const w = world();

    w.stop();
    w.instanceChanges();
    w.settles();
    w.pluginChanges();

    expect(w.heard).toEqual([]);
  });

  it('hears a change to a fact it is handed or to a plugin source file, and no change to another file', async () => {
    const fake = fakeInstanceAdapter(readingFixture());
    const instance = instanceOver(fake.adapter);
    const heard: (PluginAddress | undefined)[] = [];
    const stop = heardChanges({ asker: problemsAsker(new InMemoryMEditClient()), instance, facts: { profiles: true } }, (plugin) => { heard.push(plugin); });

    await instance.refresh();
    await instance.refresh(['/instance/mods/A/textures/a.dds']);
    await instance.refresh(['/instance/source/Repo/plugin-source/A.esp/records.yaml']);
    fake.read({ profiles: ['Default', 'Other'] });
    await instance.refresh(['/instance/profiles/Other']);

    stop();
    instance.dispose();
    expect(heard).toEqual([undefined, undefined, undefined]);
  });
});
