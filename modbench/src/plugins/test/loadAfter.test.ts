import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { indexedOver } from './pluginsOver';
import { AgentCall } from '../../drivingLib/agentGesture';
import { Refusal } from '../../drivingLib/refusal';
import { RefusedWrite } from '../../drivingLib/writingGesture';
import { refusing } from '../../test/fakeInstanceAdapter';
import { aWriteInFlight } from '../../test/writeInFlight';

const LOAD_AFTER = 'modbench.plugin.loadAfter';
const wrote = (...additions: { plugin: string; after: string[] }[]) => [{ verb: 'changeUserlist', additions }];

async function loadingAfter(refusal?: string) {
  const made = await indexedOver(['A.esp', 'B.esp', 'C.esp', 'D.esp'], { answers: { refusals: refusal === undefined ? undefined : refusing('changeUserlist', refusal) } });
  const own = () => made.reporter('pluginListTree.loadAfter').reports;
  return { ...made, own, loadAfter: (...args: unknown[]) => host.run(LOAD_AFTER, ...args) };
}

describe('modbench.plugin.loadAfter', () => {
  it('picks many of the places offered outside the selection, and writes a rule for each selected plugin', async () => {
    const { fake, own, row, loadAfter } = await loadingAfter();
    host.picks(() => ['C.esp', 'D.esp']);

    await loadAfter(row('A.esp'), [row('A.esp'), row('B.esp')]);

    expect(host.quickPicks.map(({ items, canPickMany }) => [items, canPickMany])).toEqual([[['C.esp', 'D.esp'], true]]);
    expect([fake.calls, own()]).toEqual([wrote({ plugin: 'A.esp', after: ['C.esp', 'D.esp'] }, { plugin: 'B.esp', after: ['C.esp', 'D.esp'] }), []]);
  });

  it.each([
    ['the pick is dismissed', undefined],
    ['nothing is picked', []],
  ])('writes nothing when %s', async (_case, picked) => {
    const { fake, row, loadAfter } = await loadingAfter();
    host.picks(() => picked);

    await loadAfter(row('A.esp'));

    expect(fake.calls).toEqual([]);
  });

  it('says why when the userlist cannot be written', async () => {
    const { own, row, loadAfter } = await loadingAfter('userlist.yaml is not a map');
    host.picks(() => ['C.esp']);

    await loadAfter(row('A.esp'));

    expect(own()).toEqual([{ severity: 'error', message: 'Could not write the load after.', detail: 'userlist.yaml is not a map' }]);
  });
});

describe('modbench.plugin.loadAfter, asked while a write is in flight', () => {
  it('tells the user once, as a refusal and no failure', async () => {
    const { fake, own, row, loadAfter } = await loadingAfter();
    const { told } = aWriteInFlight();
    host.picks(() => ['C.esp']);

    await loadAfter(row('A.esp'));

    expect({ calls: fake.calls, own: own(), told: told.reports.map(({ message }) => message) }).toEqual({
      calls: [], own: [], told: ['modbench.plugin.loadAfter did not start: modbench.test.held is still writing.'],
    });
  });

  it('goes back to the agent as the refusal', async () => {
    const { loadAfter } = await loadingAfter();
    aWriteInFlight();
    const call = new AgentCall([{ kind: 'plugin', plugin: { name: 'A.esp', origin: 'ModA' } }], { after: [{ name: 'C.esp' }] });

    await expect(loadAfter(call)).rejects.toBeInstanceOf(RefusedWrite);
  });
});

describe('modbench.plugin.loadAfter, called by the agent', () => {
  const call = (plugins: string[], after: string[]) =>
    new AgentCall(plugins.map((name) => ({ kind: 'plugin' as const, plugin: { name, origin: 'ModA' } })), { after: after.map((name) => ({ name })) });

  it('names the plugins they load after, and answers the outcome', async () => {
    const { fake, loadAfter } = await loadingAfter();

    const answered = await loadAfter(call(['A.esp'], ['C.esp']));

    expect([fake.calls, answered]).toEqual([wrote({ plugin: 'A.esp', after: ['C.esp'] }), { applied: true, outcome: { landed: [{ name: 'A.esp', origin: 'ModA' }], refused: [] } }]);
  });

  it.each([
    ['a plugin that loads after itself', ['A.esp', 'B.esp'], ['B.esp']],
    ['a call that names no plugin to load after', ['A.esp'], []],
  ])('refuses %s, writing nothing', async (_case, plugins, after) => {
    const { fake, loadAfter } = await loadingAfter();

    await expect(loadAfter(call(plugins, after))).rejects.toBeInstanceOf(Refusal);

    expect(fake.calls).toEqual([]);
  });
});
