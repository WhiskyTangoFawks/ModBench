import { describe, it, expect } from 'vitest';
import { problemsAsker } from '../problemsAsker';
import { REQUESTS_AT_ONCE } from '../../ports/bounded';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { loadOrderStatusEventFixture } from '../../client/test/fixtures';
import type { PluginAddress, PluginFilePaths } from '../../client';

const A: PluginAddress = { name: 'A.esp', origin: 'ModA' };
const B: PluginAddress = { name: 'B.esp', origin: 'ModB' };
const answerFor = (plugin: PluginAddress): PluginFilePaths => ({ plugin, paths: [], scripts: [], unread: [] });

const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const asked = (client: InMemoryMEditClient, method = 'getPluginFilePaths') => client.calls.filter((call) => call.method === method).map((call) => call.args);
const changed = (client: InMemoryMEditClient, plugin: PluginAddress) => { client.emit({ kind: 'plugin-changed', plugin: plugin.name, origin: plugin.origin, keys: [], sequence: 1 }); };

function started() {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getPluginFilePaths', [answerFor(A), answerFor(B)]);
  return { client, asker: problemsAsker(client) };
}

describe('problemsAsker', () => {
  it('asks the whole set once however many ask for it, before and after it is answered', async () => {
    const { client, asker } = started();

    const answers = await Promise.all([asker.getPluginFilePaths(), asker.getPluginFilePaths()]);
    answers.push(await asker.getPluginFilePaths());

    expect([asked(client), answers.map((answer) => answer)]).toEqual([[[undefined]], Array(3).fill([answerFor(A), answerFor(B)])]);
  });

  it('answers a plugin from the whole set it holds', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths();

    expect([await asker.getPluginFilePaths(B), asked(client)]).toEqual([[answerFor(B)], [[undefined]]]);
  });

  it('asks again of a plugin a notification names, and of the whole set, and keeps what it holds of the others', async () => {
    const { client, asker } = started();
    client.setQueryAnswerOnce('getPluginFilePaths', [answerFor(A)]);
    client.setQueryAnswerOnce('getPluginFilePaths', [answerFor(B)]);
    client.setQueryAnswerOnce('getPluginFilePaths', [{ ...answerFor(A), unread: ['changed'] }]);
    await asker.getPluginFilePaths(A);
    await asker.getPluginFilePaths(B);

    changed(client, A);

    expect([await asker.getPluginFilePaths(A), await asker.getPluginFilePaths(B), asked(client)]).toEqual([
      [{ ...answerFor(A), unread: ['changed'] }], [answerFor(B)], [[A], [B], [A]],
    ]);
  });

  it('asks again of every plugin once the load order settles', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths();

    client.emit(loadOrderStatusEventFixture({ state: 'Ready', conflictsComputed: true, version: 2 }));
    await asker.getPluginFilePaths();

    expect(asked(client)).toEqual([[undefined], [undefined]]);
  });

  it('holds no failure: the next ask asks again', async () => {
    const { client, asker } = started();
    client.setQueryFailureOnce('getPluginFilePaths', { failed: 'timed-out' });

    const failed = await asker.getPluginFilePaths();
    const answered = await asker.getPluginFilePaths();

    expect([failed, answered, asked(client)]).toEqual([{ failed: 'timed-out' }, [answerFor(A), answerFor(B)], [[undefined], [undefined]]]);
  });

  it('answers a feed that a notification wakes with the answer after the change, never the one held before', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths(A);
    const heard: unknown[] = [];
    client.onNotification('plugin-changed', ({ plugin }) => { void asker.getPluginFilePaths(plugin).then((answer) => { heard.push(answer); }); });
    client.setQueryAnswer('getPluginFilePaths', [{ ...answerFor(A), unread: ['after'] }]);

    changed(client, A);
    await turn();

    expect(heard).toEqual([[{ ...answerFor(A), unread: ['after'] }]]);
  });

  it.each(['getPluginFilePaths', 'getPluginProblems'] as const)('sends no more %s requests at once than its limit', async (method) => {
    const client = new InMemoryMEditClient();
    const release: (() => void)[] = [];
    for (let each = 0; each < REQUESTS_AT_ONCE + 3; each += 1) client.setQueryAnswerOnce(method, new Promise<never[]>((resolve) => { release.push(() => { resolve([]); }); }));
    const asker = problemsAsker(client);

    const answers = Array.from({ length: REQUESTS_AT_ONCE + 3 }, (_, each) => asker[method]({ name: `P${each}.esp`, origin: 'Mod' }));
    await turn();
    const inFlight = asked(client, method).length;
    for (const [index] of answers.entries()) { release[index]?.(); await turn(); }
    await Promise.all(answers);

    expect([inFlight, asked(client, method).length]).toEqual([REQUESTS_AT_ONCE, REQUESTS_AT_ONCE + 3]);
  });
});
