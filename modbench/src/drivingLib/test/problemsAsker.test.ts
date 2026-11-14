import { describe, it, expect } from 'vitest';
import { problemsAsker } from '../problemsAsker';
import { REQUESTS_AT_ONCE } from '../../ports/bounded';
import type { PluginAddress } from '../../wire/pluginAddress';
import type { ReadFailed } from '../../wire/readFailed';

interface Answered { plugin: PluginAddress; unread: string[]; failure?: string }
type Answer = Answered[] | ReadFailed;
type Method = 'getPluginFilePaths' | 'getPluginProblems';

const A: PluginAddress = { name: 'A.esp', origin: 'ModA' };
const B: PluginAddress = { name: 'B.esp', origin: 'ModB' };
const answerFor = (plugin: PluginAddress, over: Partial<Answered> = {}): Answered => ({ plugin, unread: [], ...over });
const TIMED_OUT: ReadFailed = { failed: 'timed-out' };

const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function fakeClient() {
  const calls: { method: Method; plugin?: PluginAddress }[] = [];
  const queued: Record<Method, (() => Promise<Answer>)[]> = { getPluginFilePaths: [], getPluginProblems: [] };
  const standing: Record<Method, Answer> = { getPluginFilePaths: [answerFor(A), answerFor(B)], getPluginProblems: [] };
  const changed = new Set<(event: { plugin: PluginAddress }) => void>();
  const settled = new Set<(status: { conflictsComputed: boolean }) => void>();
  const read = (method: Method) => (plugin?: PluginAddress): Promise<Answer> => {
    calls.push({ method, plugin });
    return queued[method].shift()?.() ?? Promise.resolve(standing[method]);
  };
  const subscribe = <T>(listeners: Set<T>, listener: T) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  return {
    calls,
    getPluginFilePaths: read('getPluginFilePaths'),
    getPluginProblems: read('getPluginProblems'),
    onNotification: (_kind: 'rows-changed' | 'plugin-changed', listener: (event: { plugin: PluginAddress }) => void) => subscribe(changed, listener),
    onLoadOrderSettled: (listener: (status: { conflictsComputed: boolean }) => void) => subscribe(settled, listener),
    answerNext: (method: Method, answer: () => Promise<Answer>) => { queued[method].push(answer); },
    answerAlways: (method: Method, answer: Answer) => { standing[method] = answer; },
    gate: (method: Method, count: number, answer: Answer = []) => {
      const release: { now: () => void }[] = Array.from({ length: count }, () => ({ now: () => undefined }));
      release.forEach((each) => queued[method].push(() => new Promise<Answer>((resolve) => { each.now = () => { resolve(answer); }; })));
      return release;
    },
    pluginChanged: (plugin: PluginAddress) => { for (const listener of changed) listener({ plugin }); },
    loadOrderSettled: () => { for (const listener of settled) listener({ conflictsComputed: true }); },
    asked: (method: Method = 'getPluginFilePaths') => calls.filter((call) => call.method === method).map(({ plugin }) => plugin),
  };
}

function started() {
  const client = fakeClient();
  return { client, asker: problemsAsker(client) };
}

describe('problemsAsker', () => {
  it('asks the whole set once however many ask for it, before and after it is answered', async () => {
    const { client, asker } = started();

    const answers = await Promise.all([asker.getPluginFilePaths(), asker.getPluginFilePaths()]);
    const later = await asker.getPluginFilePaths();

    expect([client.asked(), [...answers, later]]).toEqual([[undefined], Array(3).fill([answerFor(A), answerFor(B)])]);
  });

  it('answers a plugin from the whole set it holds', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths();

    expect([await asker.getPluginFilePaths(B), client.asked()]).toEqual([[answerFor(B)], [undefined]]);
  });

  it('asks again of a plugin a notification names, and of the whole set, and keeps what it holds of the others', async () => {
    const { client, asker } = started();
    client.answerNext('getPluginFilePaths', () => Promise.resolve([answerFor(A)]));
    client.answerNext('getPluginFilePaths', () => Promise.resolve([answerFor(B)]));
    client.answerNext('getPluginFilePaths', () => Promise.resolve([answerFor(A, { unread: ['changed'] })]));
    await asker.getPluginFilePaths(A);
    await asker.getPluginFilePaths(B);
    asker.onPluginChanged(() => undefined);

    client.pluginChanged(A);

    expect([await asker.getPluginFilePaths(A), await asker.getPluginFilePaths(B), client.asked()]).toEqual([
      [answerFor(A, { unread: ['changed'] })], [answerFor(B)], [A, B, A],
    ]);
  });

  it('tells a listener of a change only after it dropped what it held, so the listener is answered after the change', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths(A);
    const heard: unknown[] = [];
    asker.onPluginChanged(({ plugin }) => { void asker.getPluginFilePaths(plugin).then((answer) => { heard.push(answer); }); });
    client.answerAlways('getPluginFilePaths', [answerFor(A, { unread: ['after'] })]);

    client.pluginChanged(A);
    await turn();

    expect(heard).toEqual([[answerFor(A, { unread: ['after'] })]]);
  });

  it('tells a listener of a settled load order only after it dropped everything it held', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths();
    const heard: unknown[] = [];
    asker.onLoadOrderSettled(() => { void asker.getPluginFilePaths().then((answer) => { heard.push(answer); }); });
    client.answerAlways('getPluginFilePaths', [answerFor(A, { unread: ['after'] })]);

    client.loadOrderSettled();
    await turn();

    expect(heard).toEqual([[answerFor(A, { unread: ['after'] })]]);
  });

  it('asks again of the whole set after it is told to forget, as when the instance changes', async () => {
    const { client, asker } = started();
    await asker.getPluginFilePaths();

    asker.forget();
    await asker.getPluginFilePaths();

    expect(client.asked()).toEqual([undefined, undefined]);
  });

  it.each([
    ['a failure of mEdit', () => Promise.resolve(TIMED_OUT)],
    ['a rejected request', () => Promise.reject(new Error('refused'))],
  ])('holds no answer that is %s: the next ask asks again', async (_case, answer) => {
    const { client, asker } = started();
    client.answerNext('getPluginFilePaths', answer);

    await asker.getPluginFilePaths().catch(() => undefined);
    const answered = await asker.getPluginFilePaths();

    expect([answered, client.asked()]).toEqual([[answerFor(A), answerFor(B)], [undefined, undefined]]);
  });

  it.each([
    ['a plugin it could not read', { failure: 'unreadable' }],
    ['a line it could not read', { unread: ['stopped'] }],
  ])('holds no answer that carries %s: the next ask asks again', async (_case, over) => {
    const { client, asker } = started();
    client.answerNext('getPluginFilePaths', () => Promise.resolve([answerFor(A, over)]));

    await asker.getPluginFilePaths();
    await asker.getPluginFilePaths();

    expect(client.asked()).toEqual([undefined, undefined]);
  });

  it('holds the answer of the ask made after a change, never the late answer of one made before it', async () => {
    const { client, asker } = started();
    const [late] = client.gate('getPluginFilePaths', 1, TIMED_OUT);
    const before = asker.getPluginFilePaths(A);
    await turn();
    asker.forget(A);
    client.answerNext('getPluginFilePaths', () => Promise.resolve([answerFor(A)]));

    const after = await asker.getPluginFilePaths(A);
    late?.now();
    await before;
    await turn();
    await asker.getPluginFilePaths(A);

    expect([after, client.asked()]).toEqual([[answerFor(A)], [A, A]]);
  });

  it.each(['getPluginFilePaths', 'getPluginProblems'] as const)('sends no more %s requests at once than its limit', async (method) => {
    const client = fakeClient();
    const release = client.gate(method, REQUESTS_AT_ONCE + 3);
    const asker = problemsAsker(client);

    const answers = release.map((_, each) => asker[method]({ name: `P${each}.esp`, origin: 'Mod' }));
    await turn();
    const inFlight = client.asked(method).length;
    await release.reduce(async (done, each) => { await done; each.now(); await turn(); }, Promise.resolve());
    await Promise.all(answers);

    expect([inFlight, client.asked(method).length]).toEqual([REQUESTS_AT_ONCE, REQUESTS_AT_ONCE + 3]);
  });

  it('shares its limit with the work it is given to run, and starts the urgent work first', async () => {
    const client = fakeClient();
    const release = client.gate('getPluginFilePaths', REQUESTS_AT_ONCE + 1);
    const asker = problemsAsker(client);
    const order: string[] = [];

    const waiting = release.map((_, each) => asker.getPluginFilePaths({ name: `P${each}.esp`, origin: 'Mod' }));
    let finishUrgent: () => void = () => undefined;
    const urgent = asker.inTurn(() => { order.push('urgent'); return new Promise<void>((resolve) => { finishUrgent = resolve; }); }, true);
    await turn();
    const beforeRelease = [...order];
    release[0]?.now();
    await turn();

    expect([beforeRelease, order, client.asked().length]).toEqual([[], ['urgent'], REQUESTS_AT_ONCE]);
    finishUrgent();
    await turn();
    release.forEach((each) => { each.now(); });
    await Promise.all([...waiting, urgent]);
  });
});
