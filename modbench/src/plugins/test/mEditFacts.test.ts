import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => import('./vscodeHost'));

import { host } from './vscodeHost';
import { deferred, factsOver, settle } from './pluginsOver';
import type { PluginDiagnosisReport, PluginMetadata } from '../../client';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { holdsLoadOrder, holdsNoLoadOrder } from '../../client/test/says';
import type { ReadFailed } from '../../wire/readFailed';

const A = { name: 'A.esp', origin: 'SomeMod' };
const B = { name: 'B.esp', origin: 'SomeMod' };
const UNREACHABLE = { failed: 'unreachable' } as const;
const REFUSED = { failed: 'refused', refusal: '503' } as const;

const held = (overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const diagnosis = (text: string): PluginDiagnosisReport => ({ plugin: 'A.esp', origin: 'SomeMod', text });


type Facts = ReturnType<typeof factsOver>;
const compiled = async (facts: Facts, address = A) => (await facts.row(address.name, address.origin))?.context.includes('compiledPlugin');
const factsAsked = (facts: Facts) => facts.client.calls.filter(({ method }) => method === 'getPlugins').map(({ args }) => args);
const handOffs = (facts: Facts) => facts.output.filter((line) => line.includes('applying reconciled load order')).length;
const refusing = (message: string): PromiseLike<never> => ({ then: (_answered, refused) => Promise.reject(new Error(message)).then(undefined, refused) });
const sourceOf = (problems: readonly (readonly [string, unknown])[]) => problems.map(([path]) => path).sort();

describe('the facts mEdit answers of each plugin, read at a reconcile', () => {
  it('takes the facts of the plugins it shows, and counts them in the Output', async () => {
    const facts = factsOver([A]);

    await facts.reconciled([held({ isCompiledPlugin: true }), held({ name: 'Unshown.esp' })]);

    expect(await compiled(facts)).toBe(true);
    expect(facts.output.filter((line) => line.includes('applying reconciled load order'))).toEqual([
      '[loadOrder] applying reconciled load order to tree: 1 in the load order, 0 failed, of 1 plugins',
    ]);
  });

  const disconnected = [undefined, { kind: 'error', message: 'mEdit is disconnected.' }];

  it('a failed re-read that mEdit going away superseded leaves the rows to the disconnect', async () => {
    const facts = factsOver([A]);
    const answer = deferred<ReadFailed>();
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    await facts.indexed();
    await facts.changed(UNREACHABLE);

    await facts.unreachable();
    answer.resolve(UNREACHABLE);
    await settle();

    expect([facts.message(), await facts.expansion('A.esp')]).toEqual(disconnected);
  });

  it('a failed hand-off that mEdit going away superseded leaves the rows to the disconnect', async () => {
    const facts = factsOver([A]);
    const answer = deferred<ReadFailed>();
    facts.client.setQueryAnswerOnce('getPlugins', Promise.resolve(UNREACHABLE));
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    await facts.reconciled(UNREACHABLE);
    const whileTheHandOffReads = facts.message();

    await facts.unreachable();
    answer.resolve(UNREACHABLE);
    await settle();

    expect([whileTheHandOffReads, facts.message(), await facts.expansion('A.esp')]).toEqual([undefined, ...disconnected]);
  });

  it('drops a reconcile answer that lands after a newer event', async () => {
    const facts = factsOver([A]);
    const answer = deferred<PluginMetadata[]>();
    facts.client.setQueryAnswerOnce('getPlugins', Promise.resolve([]));
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    await facts.reconciled([]);
    const whileTheHandOffReads = handOffs(facts);

    await facts.indexed();
    answer.resolve([held({ isCompiledPlugin: true })]);
    await settle();

    expect([whileTheHandOffReads, await compiled(facts)]).toEqual([0, false]);
  });

  it('a fact re-read during a reconcile hand-off leaves the hand-off standing', async () => {
    const facts = factsOver([A]);
    const answer = deferred<PluginMetadata[]>();
    facts.client.setQueryAnswerOnce('getPlugins', Promise.resolve([]));
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    await facts.reconciled([held({ isCompiledPlugin: true })]);

    await facts.changed([held({ isCompiledPlugin: true })]);
    const whileTheHandOffReads = handOffs(facts);
    answer.resolve([held({ isCompiledPlugin: true })]);
    await settle();

    expect([whileTheHandOffReads, handOffs(facts), await compiled(facts)]).toEqual([0, 1, true]);
  });
});

describe('a change while mEdit rebuilds the record index, when it opens no plugin', () => {
  it('leaves a row it does not hold still indexing, never an error', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()]);
    await facts.indexed();

    await facts.changed([]);

    expect(await facts.expansion('A.esp')).toEqual({ kind: 'indexing' });
  });
});

describe('the facts read again as mEdit\'s change event names plugins', () => {
  it('reads and publishes again only the changed outside standing and unreadable source of the plugins named', async () => {
    const facts = factsOver([A, B]);
    const unreadable = { pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } };
    await facts.reconciled([held(unreadable), held({ name: 'B.esp', ...unreadable })], { changedOutside: [A, B] });
    facts.client.calls.length = 0;

    await facts.changed([held(unreadable)], [A], [A]);

    expect(facts.client.calls.filter(({ method, args }) => method === 'getPluginsIndexing' && args.length > 0).map(({ args }) => args)).toEqual([[[A]]]);
    expect([sourceOf(host.problems('modbench-changed-outside')), sourceOf(host.problems('modbench-source-unreadable'))]).toEqual([
      ['/mods/SomeMod/A.esp', '/mods/SomeMod/B.esp'], ['/mods/SomeMod/A.esp', '/mods/SomeMod/B.esp'],
    ]);
  });

  it('asks again only for the plugins named, and keeps what it holds of the others', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held({ isCompiledPlugin: true }), held({ name: 'B.esp', isCompiledPlugin: true })]);
    facts.client.calls.length = 0;

    await facts.changed([held({ isCompiledPlugin: false })], [A]);

    expect([factsAsked(facts), await compiled(facts), await compiled(facts, B)]).toEqual([[[[A]]], false, true]);
  });

  it('asks for every plugin when it is named none', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held(), held(B)]);
    facts.client.calls.length = 0;

    await facts.changed([held(), held(B)]);

    expect(factsAsked(facts)).toEqual([[]]);
  });

  it('forgets a named plugin the answer does not hold', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held(), held({ name: 'B.esp', isCompiledPlugin: true })]);

    await facts.changed([], [B]);

    expect(await compiled(facts, B)).toBe(false);
  });

  it('names each re-read\'s plugins on its own change, in the order they were asked', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held(), held(B)]);
    const answer = deferred<PluginMetadata[]>();
    facts.client.setQueryAnswerOnce('getPlugins', answer.promise);
    const redrawn: unknown[] = [];
    facts.view().treeDataProvider.onDidChangeTreeData?.((row) => redrawn.push(row));

    await facts.changed([held(), held(B)], [A]);
    await facts.changed([held(), held(B)], [B]);
    answer.resolve([held()]);
    await settle();

    const row = await facts.pluginRows();
    expect(redrawn).toEqual([row('A.esp', 'SomeMod'), row('B.esp', 'SomeMod'), row('A.esp', 'SomeMod'), row('B.esp', 'SomeMod')]);
  });

  it('asks for every plugin after a failed read, so a plugin the failed read named is not left stale', async () => {
    const facts = factsOver([A, B]);
    await facts.reconciled([held({ isCompiledPlugin: false }), held(B)]);
    facts.client.setQueryFailureOnce('getPlugins', UNREACHABLE);
    await facts.changed([held({ isCompiledPlugin: false }), held(B)], [A]);
    facts.client.calls.length = 0;

    await facts.changed([held({ isCompiledPlugin: true }), held(B)], [B]);

    expect([factsAsked(facts), await compiled(facts)]).toEqual([[[]], true]);
  });

  it('keeps apart two plugins whose names differ only in case', async () => {
    const lower = { name: 'a.esp', origin: 'SomeMod' };
    const facts = factsOver([A, lower]);
    await facts.reconciled([held({ isCompiledPlugin: true }), held({ name: 'a.esp', isCompiledPlugin: false })]);

    await facts.changed([held({ name: 'a.esp', isCompiledPlugin: false })], [lower]);

    expect(await compiled(facts)).toBe(true);
  });

  it('asks nothing when it is named no plugin', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()]);
    facts.client.calls.length = 0;

    await facts.changed([held()], []);

    expect(factsAsked(facts)).toEqual([]);
  });

  it('asks nothing while mEdit says it holds no load order', async () => {
    const facts = factsOver([A]);
    holdsNoLoadOrder(facts.client);

    await facts.changed([held()]);

    expect(factsAsked(facts)).toEqual([]);
  });

  it('asks nothing once mEdit has gone, until the restarted mEdit holds a load order', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()]);
    holdsNoLoadOrder(facts.client);
    facts.client.calls.length = 0;

    await facts.changed([held()]);
    const whileNoneHeld = factsAsked(facts);
    holdsLoadOrder(facts.client, { settled: false });
    await facts.changed([held()]);

    expect({ whileNoneHeld, after: factsAsked(facts) }).toEqual({ whileNoneHeld: [], after: [[]] });
  });

  it('a later re-read lands over an earlier one still in flight', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()]);
    const earlier = deferred<PluginMetadata[]>();
    facts.client.setQueryAnswerOnce('getPlugins', earlier.promise);

    await facts.changed([held({ isCompiledPlugin: false })]);
    await facts.changed([held({ isCompiledPlugin: false })]);
    earlier.resolve([held({ isCompiledPlugin: true })]);
    await settle();

    expect(await compiled(facts)).toBe(false);
  });

  it.each([
    ['a reconcile', (facts: Facts, answer: PluginMetadata[]) => facts.reconciled(answer)],
    ['a facts re-read', async (facts: Facts, answer: PluginMetadata[]) => { await facts.indexed({ indexed: [A] }); await facts.changed(answer); }],
  ])('publishes a plugin whose plugin source is unreadable to the Problems panel on %s', async (_what, read) => {
    const facts = factsOver([A]);

    await read(facts, [held({ pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } })]);

    expect(sourceOf(host.problems('modbench-source-unreadable'))).toEqual(['/mods/SomeMod/A.esp']);
  });

  it('publishes a plugin mEdit never opened and says changed outside, which no row of its facts names', async () => {
    const never = { name: 'Never.esp', origin: 'SomeMod' };
    const facts = factsOver([never]);
    await facts.indexed({ failures: [{ ...never, reason: 'truncated' }] });

    await facts.changed([], undefined, [never]);

    expect(sourceOf(host.problems('modbench-changed-outside'))).toEqual(['/mods/SomeMod/Never.esp']);
  });

  it.each([
    ['a facts re-read', async (facts: Facts) => { await facts.indexed({ indexed: [A] }); await facts.changed([held()], undefined, [A]); }],
    ['a reconcile', (facts: Facts) => facts.reconciled([held()], { changedOutside: [A] })],
  ])('publishes the plugin mEdit says changed outside, to the Problems panel on %s', async (_what, read) => {
    const facts = factsOver([A]);

    await read(facts);

    expect(sourceOf(host.problems('modbench-changed-outside'))).toEqual(['/mods/SomeMod/A.esp']);
  });
});

describe('the malformed-plugin scan', () => {
  it('a failed scan leaves the last answer', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()], { diagnoses: [diagnosis('first')] });

    await facts.reconciled([held()], { diagnoses: REFUSED });

    expect(host.problems('modbench-diagnosis').map(([, shown]) => shown.map(({ message }) => message))).toEqual([['first']]);
  });

  it('keeps the last diagnoses on the rows when the next scan fails', async () => {
    const facts = factsOver([A]);
    await facts.reconciled([held()], { diagnoses: [diagnosis('first')] });

    await facts.reconciled([held()], { diagnoses: REFUSED });

    expect([(await facts.row('A.esp'))?.description, facts.message()]).toEqual(['malformed', expect.stringContaining('503')]);
  });

  it('drops a failed scan that a newer event superseded, and changes no facts', async () => {
    const facts = factsOver([A]);
    const scan = deferred<PluginDiagnosisReport[] | ReadFailed>();
    facts.client.setQueryAnswerOnce('getDiagnoses', scan.promise);
    await facts.reconciled([held()]);

    await facts.unreachable();
    scan.resolve({ failed: 'refused', refusal: 'late' });
    await settle();

    expect(facts.message()).toBeUndefined();
  });

  it('drops a scan answer that lands after a newer event', async () => {
    const facts = factsOver([A]);
    const scan = deferred<PluginDiagnosisReport[]>();
    facts.client.setQueryAnswerOnce('getDiagnoses', scan.promise);
    await facts.reconciled([held()]);

    await facts.indexed();
    scan.resolve([diagnosis('stale')]);
    await settle();

    expect([host.problems('modbench-diagnosis'), (await facts.row('A.esp'))?.description]).toEqual([[], undefined]);
  });
});

describe('a throw that is no failed read', () => {
  it('is not folded into the unreadable-plugin-list rows, and reaches the caller', async () => {
    const facts = factsOver([A]);
    facts.client.setQueryAnswerOnce('getPlugins', Promise.resolve([]));
    facts.client.setQueryAnswerOnce('getPlugins', refusing('the read broke'));

    await facts.reconciled([held()]);

    expect([facts.message(), facts.output.filter((line) => line.includes('threw'))]).toEqual([
      undefined, ['[loadOrder] handing the reconciled load order to the views threw: the read broke'],
    ]);
  });

  it('is not folded into a failed scan on the rows, and is left unhandled', async () => {
    const facts = factsOver([A]);
    facts.client.setQueryAnswerOnce('getDiagnoses', refusing('the scan broke'));

    const thrown = await nextUnhandledRejection(() => facts.reconciled([held()]));

    expect([thrown, facts.message()]).toEqual([new Error('the scan broke'), undefined]);
  });

  it('reads the next re-read after one that threw', async () => {
    const facts = factsOver([A]);
    await facts.indexed({ indexed: [A] });
    facts.client.setQueryAnswerOnce('getPlugins', refusing('the read broke'));
    await facts.changed([held({ isCompiledPlugin: true })]);
    const afterTheThrow = await compiled(facts);

    await facts.changed([held({ isCompiledPlugin: true })]);

    expect([afterTheThrow, await compiled(facts)]).toEqual([false, true]);
  });
});

async function nextUnhandledRejection(trigger: () => Promise<unknown>): Promise<unknown> {
  const others = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  try {
    return await new Promise((resolve) => {
      process.once('unhandledRejection', resolve);
      void trigger();
    });
  } finally {
    for (const listener of others) process.on('unhandledRejection', listener);
  }
}
