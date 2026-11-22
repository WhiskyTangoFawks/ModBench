import { describe, it, expect, vi } from 'vitest';
import type { PluginAddress, PluginDiagnosisReport, PluginMetadata } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import type { ReadFailed } from '../../wire/readFailed';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { PluginFactsFeed, type PluginFactsFeedDeps } from '../pluginFactsFeed';
import { rulesReader, type SortingRuleFiles } from '../../sortingRules/lootMetadata';
import { holdsLoadOrder, holdsNoLoadOrder } from '../../client/test/says';
import type { NamedPlugins } from '../pluginAddress';

const USERLIST = '/instance/userlist.yaml';
const filesWith = (masterlist: string, userlist = ''): SortingRuleFiles => ({
  masterlist: { path: '/instance/masterlist.yaml', kind: 'text', text: masterlist },
  prelude: { path: '/instance/prelude.yaml', kind: 'absent' },
  userlist: userlist === '' ? { path: USERLIST, kind: 'absent' } : { path: USERLIST, kind: 'text', text: userlist },
});
const rulesOf = (files: SortingRuleFiles): ReturnType<PluginFactsFeedDeps['rules']> => rulesReader()(files);
const NO_RULES = rulesOf(filesWith('plugins: []\n'));

const A = { name: 'A.esp', origin: 'SomeMod' };
const held = (overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const diagnosis = (text: string): PluginDiagnosisReport => (
  { plugin: 'A.esp', origin: 'SomeMod', text }
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function watched<T>() {
  const items: T[] = [];
  const waiting: (() => void)[] = [];
  return {
    items,
    push: (item: T) => { items.push(item); for (const wake of waiting.splice(0)) wake(); },
    next: () => new Promise<void>((resolve) => { waiting.push(resolve); }),
  };
}

function clientFindingNoDefects(): InMemoryMEditClient {
  const client = new InMemoryMEditClient();
  client.setQueryAnswer('getDiagnoses', []);
  return client;
}

interface FeedOptions {
  readonly shownPlugins?: () => readonly PluginAddress[];
  readonly activePlugins?: () => readonly PluginAddress[];
  readonly publishDiagnoses?: (reports: PluginDiagnosisReport[]) => void;
  readonly rules?: () => ReturnType<PluginFactsFeedDeps['rules']>;
  readonly present?: readonly string[];
  readonly asked?: (reads: unknown) => void;
  readonly gates?: readonly Promise<undefined>[];
  readonly holdsALoadOrder?: boolean;
}

const factsAsked = (client: InMemoryMEditClient) => client.calls.filter(({ method }) => method === 'getPlugins').map(({ args }) => args);

function feedOver({
  shownPlugins = () => [A], activePlugins = () => [], publishDiagnoses, rules = () => NO_RULES, present = [], asked, gates = [], holdsALoadOrder = true,
}: FeedOptions = {}) {
  const client = clientFindingNoDefects();
  if (holdsALoadOrder) holdsLoadOrder(client);
  const diagnoses = watched<readonly PluginDiagnosisReport[]>();
  const changedOutside = watched<readonly { plugin: string; origin: string }[]>();
  const changedOutsideOf = watched<NamedPlugins>();
  const sourceUnreadableOf = watched<NamedPlugins>();
  const sourceUnreadable = watched<readonly { plugin: string; origin: string }[]>();
  const sortingErrors = watched<readonly { plugin: string; origin: string; text: string }[]>();
  const sortingWarnings = watched<readonly { plugin: string; origin: string; text: string }[]>();
  const sortingInfo = watched<readonly { plugin: string; origin: string; text: string }[]>();
  const ruleFiles = watched<readonly { path: string; line: number; level: string; text: string }[]>();
  let calls = 0;
  const feed = new PluginFactsFeed({
    client, shownPlugins, activePlugins, rules, lines: activePlugins,
    fileFacts: async (reads) => {
      asked?.(reads);
      await gates[calls++];
      return { files: () => ({ names: present, complete: true }), isPresent: (path) => (present.includes(path) ? 'present' : 'absent'), answer: () => ({ kind: 'read', value: undefined }) };
    },
    publishSortingInfo: sortingInfo.push,
    publishRuleFiles: ruleFiles.push,
    publishDiagnoses: publishDiagnoses ?? diagnoses.push,
    publishChangedOutside: (warnings, named) => { changedOutside.push(warnings); changedOutsideOf.push(named); },
    publishFailedToRead: () => undefined,
    publishSourceUnreadable: (warnings, named) => { sourceUnreadable.push(warnings); sourceUnreadableOf.push(named); },
    publishSortingErrors: sortingErrors.push,
    publishSortingWarnings: sortingWarnings.push,
  });
  const changes = vi.fn();
  feed.onDidChange(changes);
  return { feed, client, diagnoses, changedOutside, changedOutsideOf, sourceUnreadable, sourceUnreadableOf, sortingErrors, sortingWarnings, sortingInfo, ruleFiles, changes };
}

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

const compiledPluginFlag = (feed: PluginFactsFeed) => feed.rows.contextFlags(A).includes('compiledPlugin');

describe('PluginFactsFeed', () => {
  it('lands a reconcile: the plugins shown become queryable, the change event fires, and the count returns', async () => {
    const { feed, client, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true }), held({ name: 'Unshown.esp' })]);
    client.setQueryAnswer('getDiagnoses', []);

    expect(await feed.reconciled([])).toEqual({ held: 1, active: 0, rowsGone: [] });

    expect(compiledPluginFlag(feed)).toBe(true);
    expect(feed.rows.contextFlags({ name: 'Unshown.esp', origin: 'SomeMod' })).toEqual([]);
    expect(changes).toHaveBeenCalled();
  });

  it('judges the active order at a reconcile and publishes the broken rules to the Problems panel', async () => {
    const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A] });
    client.setQueryAnswer('getPlugins', [held({ masters: ['Ghost.esm'] })]);

    await feed.reconciled([]);

    const text = '"Ghost.esm" is a master of "A.esp", and is missing or not active.';
    expect(sortingErrors.items).toEqual([[{ plugin: 'A.esp', origin: 'SomeMod', text }]]);
    expect(feed.rows.description(A)).toBe('1 error');
  });

  it('judges LOOT\'s rules with the game\'s: a requirement that is missing is a Sorting error', async () => {
    const rules = rulesOf(filesWith('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'));
    const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);

    await feed.reconciled([]);

    expect(sortingErrors.items).toEqual([[{ plugin: 'A.esp', origin: 'SomeMod', text: '"A.esp" requires "Missing.esp", which is missing.' }]]);
  });

  it('holds a LOOT condition on a plugin\'s version against the description mEdit sends', async () => {
    const rules = rulesOf(filesWith(`plugins:
  - name: A.esp
    msg:
      - {type: say, content: Old., condition: 'version("A.esp", <, "2.0")'}
      - {type: say, content: New., condition: 'version("A.esp", >=, "2.0")'}
`));
    const { feed, client, sortingInfo } = feedOver({ activePlugins: () => [A], rules: () => rules, present: ['A.esp'] });
    client.setQueryAnswer('getPlugins', [held({ description: 'Patch v2.0.5' })]);

    await feed.reconciled([]);

    expect(sortingInfo.items.flat().map(({ text }) => text)).toEqual(['New.']);
  });

  it('reads is_master() and version() of the active plugin of a name, never of a disabled copy of it', async () => {
    const rules = rulesOf(filesWith(`plugins:
  - name: A.esp
    msg:
      - {type: say, content: Master., condition: 'is_master("A.esp")'}
      - {type: say, content: Newer., condition: 'version("A.esp", >=, "2.0")'}
`));
    const disabled = { name: 'A.esp', origin: 'Disabled' };
    const { feed, client, sortingInfo } = feedOver({ shownPlugins: () => [A, disabled], activePlugins: () => [A], rules: () => rules, present: ['A.esp'] });
    client.setQueryAnswer('getPlugins', [held({ origin: 'Disabled', isMaster: true, description: 'v3.0' }), held({ isMaster: false, description: 'v1.0' })]);

    await feed.reconciled([]);

    expect(sortingInfo.items.flat()).toEqual([]);
  });

  it('asks for the file reads the conditions of the active plugins name, and the checksum of one with cleaning data', async () => {
    const rules = rulesOf(filesWith(`plugins:
  - name: A.esp
    msg: [{type: say, content: m, condition: 'readable("../G.exe")'}]
    dirty: [{crc: 0x1, util: u}]
  - name: Other.esp
    msg: [{type: say, content: m, condition: 'readable("../H.exe")'}]
`));
    const asked: unknown[] = [];
    const { feed, client } = feedOver({ activePlugins: () => [A], rules: () => rules, asked: (reads) => asked.push(reads) });
    client.setQueryAnswer('getPlugins', [held()]);

    await feed.reconciled([]);

    expect(asked).toEqual([[{ kind: 'readable', path: '../G.exe' }, { kind: 'checksum', path: 'A.esp' }]]);
  });

  it('shows a LOOT say message in the tooltip and the Problems panel at Info, and sets no icon or status', async () => {
    const rules = rulesOf(filesWith('plugins:\n  - name: A.esp\n    msg: [{type: say, content: Read the page.}]\n'));
    const { feed, client, sortingInfo } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);

    await feed.reconciled([]);

    expect(sortingInfo.items).toEqual([[{ plugin: 'A.esp', origin: 'SomeMod', text: 'Read the page.' }]]);
    expect([feed.rows.icon(A), feed.rows.description(A), feed.rows.tooltipLines(A).at(-1)]).toEqual([undefined, undefined, 'Info: Read the page.']);
  });

  it('judges a group order within the master flag\'s partitions: an ungrouped master loading after a plugin of a later group is not broken', async () => {
    const rules = rulesOf(filesWith('groups:\n  - name: default\n  - {name: fixes, after: [default]}\nplugins:\n  - {name: A.esp, group: fixes}\n'));
    const master = { name: 'M.esm', origin: 'SomeMod' };
    const { feed, client, sortingInfo } = feedOver({ shownPlugins: () => [A, master], activePlugins: () => [A, master], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held(), held({ name: 'M.esm', isMaster: true })]);

    await feed.reconciled([]);

    expect(sortingInfo.items.flat()).toEqual([]);
  });

  it('puts one group problem on the one plugin outside its group, and offers its move, however many plugins it passes', async () => {
    const rules = rulesOf(filesWith('groups:\n  - name: default\n  - {name: fixes, after: [default]}\nplugins:\n  - {name: A.esp, group: fixes}\n'));
    const others = ['B.esp', 'C.esp', 'D.esp'].map((name) => ({ name, origin: 'SomeMod' }));
    const order = [A, ...others];
    const { feed, client, sortingInfo } = feedOver({ shownPlugins: () => order, activePlugins: () => order, rules: () => rules });
    client.setQueryAnswer('getPlugins', order.map(({ name }) => held({ name })));

    await feed.reconciled([]);

    expect([sortingInfo.items.flat().map(({ plugin }) => plugin), feed.rows.suggestedMoves().map(({ mover, drop }) => [mover.name, drop])]).toEqual([
      ['A.esp'], [['A.esp', { kind: 'after', name: 'D.esp' }]],
    ]);
  });

  it('publishes a rule the userlist states on its line in the userlist', async () => {
    const rules = rulesOf(filesWith('plugins: []\n', 'plugins:\n  - name: A.esp\n    req: [B.esp]\n'));
    const { feed, client, ruleFiles } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);

    await feed.reconciled([]);

    expect(ruleFiles.items).toEqual([[{ path: USERLIST, line: 2, level: 'error', text: '"A.esp" requires "B.esp", which is missing.' }]]);
  });

  it('judges the order of the last reconcile again when the rules change, and not before one', async () => {
    let rules = NO_RULES;
    const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);
    rules = rulesOf(filesWith('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'));
    await feed.rejudge();
    const beforeReconcile = sortingErrors.items.length;

    await feed.reconciled([]);
    rules = NO_RULES;
    await feed.rejudge();

    expect([beforeReconcile, sortingErrors.items.map((errors) => errors.length)]).toEqual([0, [1, 0]]);
  });

  it('names only the plugins whose judgement the changed rules altered', async () => {
    const B = { name: 'B.esp', origin: 'SomeMod' };
    let rules = NO_RULES;
    const { feed, client, changes } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held(), held({ name: 'B.esp' })]);
    await feed.reconciled([]);
    changes.mockClear();
    rules = rulesOf(filesWith('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'));

    await feed.rejudge();

    expect(changes.mock.calls).toEqual([[[A]]]);
  });

  describe('a change while mEdit rebuilds the record index, when it opens no plugin', () => {
    it('leaves a row it does not hold still indexing, never an error', async () => {
      const { feed, client } = feedOver();
      client.setQueryAnswer('getPlugins', [held()]);
      await feed.reconciled([]);
      feed.indexed([], []);
      client.setQueryAnswer('getPlugins', []);

      await feed.refresh();

      expect(feed.rows.expansion(A)).toEqual({ kind: 'indexing' });
    });
  });

  describe('judging again as the facts are re-read', () => {
    const B = { name: 'B.esp', origin: 'SomeMod' };
    const raised = (errors: readonly (readonly unknown[])[]) => errors.map((published) => published.length > 0);
    const reads = (bIsMaster: boolean) => [held(), held({ name: 'B.esp', isMaster: bIsMaster })];

    it.each([
      ['raises the error a re-read master flag causes', false, [false, true]],
      ['clears the error a re-read dropped master flag leaves', true, [true, false]],
    ])('%s', async (_, masterAtReconcile, counts) => {
      const { feed, client, sortingErrors } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', reads(masterAtReconcile));
      await feed.reconciled([]);
      client.setQueryAnswer('getPlugins', reads(!masterAtReconcile));

      await feed.refresh();

      expect(raised(sortingErrors.items)).toEqual(counts);
    });

    it('judges again no more than a change to what the sorting rules judge, and names the plugins it was asked about', async () => {
      const asked = vi.fn();
      const { feed, client, changes } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B], asked });
      client.setQueryAnswer('getPlugins', reads(false));
      await feed.reconciled([]);
      asked.mockClear();
      changes.mockClear();
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true }), ...reads(false).slice(1)]);

      await feed.refresh([A]);

      expect([asked.mock.calls.length, changes.mock.calls]).toEqual([0, [[[A]]]]);
    });

    it('reads and publishes again only the changed outside standing and unreadable source of the plugins named', async () => {
      const { feed, client, changedOutside, changedOutsideOf, sourceUnreadable, sourceUnreadableOf } = feedOver({ shownPlugins: () => [A, B] });
      const unreadable = { pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } };
      client.setQueryAnswer('getPlugins', [held(unreadable), held({ name: 'B.esp', ...unreadable })]);
      client.setQueryAnswer('getPluginsIndexing', [A, B].map((plugin) => ({ ...plugin, state: 'Indexed' as const, changedOutside: true })));
      await feed.reconciled([]);
      client.calls.length = 0;

      await feed.refresh([A]);

      const names = (problems: readonly { plugin: string }[] | undefined) => problems?.map(({ plugin }) => plugin);
      expect([
        client.calls.filter(({ method }) => method === 'getPluginsIndexing').map(({ args }) => args),
        names(changedOutside.items.at(-1)), changedOutsideOf.items.at(-1), names(sourceUnreadable.items.at(-1)), sourceUnreadableOf.items.at(-1),
      ]).toEqual([[[[A]]], ['A.esp'], [A], ['A.esp'], [A]]);
    });

    it('asks again only for the plugins named, and keeps what it holds of the others', async () => {
      const { feed, client } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true }), held({ name: 'B.esp', isCompiledPlugin: true })]);
      await feed.reconciled([]);
      client.calls.length = 0;
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: false })]);

      await feed.refresh([A]);

      expect([factsAsked(client), feed.rows.contextFlags(A).includes('compiledPlugin'), feed.rows.contextFlags(B).includes('compiledPlugin')])
        .toEqual([[[[A]]], false, true]);
    });

    it('asks for every plugin when it is named none', async () => {
      const { feed, client } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', reads(false));
      await feed.reconciled([]);
      client.calls.length = 0;

      await feed.refresh();

      expect(factsAsked(client)).toEqual([[]]);
    });

    it('forgets a named plugin the answer does not hold', async () => {
      const { feed, client } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', reads(false));
      await feed.reconciled([]);
      client.setQueryAnswer('getPlugins', []);

      await feed.refresh([B]);

      expect(feed.rows.contextFlags(B)).toEqual([]);
    });

    it('names each re-read\'s plugins on its own change, in the order they were asked', async () => {
      const { feed, client, changes } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', reads(false));
      await feed.reconciled([]);
      changes.mockClear();
      const slow = deferred<PluginMetadata[]>();
      client.setQueryAnswerOnce('getPlugins', slow.promise);

      const earlier = feed.refresh([A]);
      const later = feed.refresh([B]);
      slow.resolve(reads(false));
      await Promise.all([earlier, later]);

      expect(changes.mock.calls).toEqual([[[A]], [[B]]]);
    });

    it('names the plugins asked about and the plugins whose judgement the re-read altered', async () => {
      const { feed, client, changes } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', [held({ isMaster: true }), held({ name: 'B.esp', isMaster: true })]);
      await feed.reconciled([]);
      changes.mockClear();
      client.setQueryAnswer('getPlugins', [held({ isMaster: false })]);

      await feed.refresh([A]);

      expect(changes.mock.calls).toEqual([[[A, B]]]);
    });

    it('asks for every plugin after a failed read, so a plugin the failed read named is not left stale', async () => {
      const { feed, client } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: false }), held({ name: 'B.esp' })]);
      await feed.reconciled([]);
      client.setQueryFailureOnce('getPlugins', { failed: 'unreachable' });
      await feed.refresh([A]);
      client.calls.length = 0;
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true }), held({ name: 'B.esp' })]);

      await feed.refresh([B]);

      expect([factsAsked(client), compiledPluginFlag(feed)]).toEqual([[[]], true]);
    });

    it('keeps apart two plugins whose names differ only in case', async () => {
      const upper = { name: 'A.esp', origin: 'SomeMod' };
      const lower = { name: 'a.esp', origin: 'SomeMod' };
      const { feed, client } = feedOver({ shownPlugins: () => [upper, lower] });
      client.setQueryAnswer('getPlugins', [held({ name: 'A.esp', isCompiledPlugin: true }), held({ name: 'a.esp', isCompiledPlugin: false })]);
      await feed.reconciled([]);
      client.setQueryAnswer('getPlugins', [held({ name: 'a.esp', isCompiledPlugin: false })]);

      await feed.refresh([lower]);

      expect(feed.rows.contextFlags(upper)).toContain('compiledPlugin');
    });

    it('asks nothing when it is named no plugin', async () => {
      const { feed, client } = feedOver();
      client.setQueryAnswer('getPlugins', [held()]);
      await feed.reconciled([]);
      client.calls.length = 0;

      await feed.refresh([]);

      expect(client.calls).toEqual([]);
    });

    it('asks nothing while mEdit says it holds no load order', async () => {
      const { feed, client } = feedOver({ holdsALoadOrder: false });
      holdsNoLoadOrder(client);
      client.calls.length = 0;

      await feed.refresh();

      expect(client.calls).toEqual([]);
    });

    it('asks nothing once mEdit has gone, until the restarted mEdit holds a load order', async () => {
      const { feed, client } = feedOver();
      client.setQueryAnswer('getPlugins', [held()]);
      await feed.reconciled([]);
      holdsNoLoadOrder(client);
      client.calls.length = 0;

      await feed.refresh();
      const whileNoneHeld = [...client.calls];
      holdsLoadOrder(client);
      await feed.refresh();

      expect({ whileNoneHeld, after: client.calls.map(({ method }) => method).filter((method) => method !== 'getPluginsIndexing') }).toEqual({ whileNoneHeld: [], after: ['getPlugins'] });
    });

    it('reads the next re-read after one that threw', async () => {
      let broken = true;
      const { feed, client } = feedOver({ shownPlugins: () => { if (broken) throw new Error('the tree broke'); return [A]; } });
      client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true })]);
      await expect(feed.refresh([A])).rejects.toThrow('the tree broke');
      broken = false;

      await feed.refresh([A]);

      expect(compiledPluginFlag(feed)).toBe(true);
    });

    it('judges again for an edited description, which a version condition of the sorting rules reads', async () => {
      const asked = vi.fn();
      const { feed, client } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B], asked });
      client.setQueryAnswer('getPlugins', reads(false));
      await feed.reconciled([]);
      asked.mockClear();
      client.setQueryAnswer('getPlugins', [held({ description: 'edited' }), ...reads(false).slice(1)]);

      await feed.refresh([A]);

      expect(asked).toHaveBeenCalled();
    });

    it('judges nothing before the first reconcile', async () => {
      const { feed, client, sortingErrors } = feedOver({ shownPlugins: () => [A, B], activePlugins: () => [A, B] });
      client.setQueryAnswer('getPlugins', reads(true));

      await feed.refresh();

      expect(sortingErrors.items).toEqual([]);
    });
  });

  describe('judging again as the rules change while a judgement is in flight', () => {
    const MISSING = rulesOf(filesWith('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'));
    const errorCounts = (errors: readonly (readonly unknown[])[]) => errors.map((published) => published.length);

    it('publishes the newest judgement, never an older one that resolves after it', async () => {
      const older = deferred<undefined>();
      let rules = NO_RULES;
      const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A], rules: () => rules, gates: [Promise.resolve(undefined), older.promise] });
      client.setQueryAnswer('getPlugins', [held()]);
      await feed.reconciled([]);
      rules = MISSING;
      const first = feed.rejudge();
      rules = NO_RULES;
      await feed.rejudge();

      older.resolve(undefined);
      await first;

      expect(errorCounts(sortingErrors.items)).toEqual([0, 0]);
    });

    it('drops a judgement of the old order that resolves after a reconcile landed the new one', async () => {
      const slow = deferred<undefined>();
      let rules = MISSING;
      const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A], rules: () => rules, gates: [Promise.resolve(undefined), slow.promise] });
      client.setQueryAnswer('getPlugins', [held()]);
      await feed.reconciled([]);
      const stale = feed.rejudge();
      rules = NO_RULES;
      await feed.reconciled([]);

      slow.resolve(undefined);
      await stale;

      expect(errorCounts(sortingErrors.items)).toEqual([1, 0]);
    });

    it('judges a reconcile by the rules that stand when its reads land', async () => {
      const slow = deferred<undefined>();
      const reading = deferred<undefined>();
      let rules = NO_RULES;
      const { feed, client, sortingErrors } = feedOver({
        activePlugins: () => [A], rules: () => rules, gates: [slow.promise], asked: () => { reading.resolve(undefined); },
      });
      client.setQueryAnswer('getPlugins', [held()]);
      const reconciling = feed.reconciled([]);
      await reading.promise;
      rules = MISSING;

      slow.resolve(undefined);
      await reconciling;

      expect(errorCounts(sortingErrors.items)).toEqual([1]);
    });
  });

  it('names an unreadable plugin list on the rows and the message line, and answers undefined', async () => {
    const { feed, client } = feedOver();
    client.setQueryFailure('getPlugins', { failed: 'unreachable' });

    expect(await feed.reconciled([])).toBeUndefined();

    expect(feed.rows.expansion(A)).toEqual({ kind: 'error', message: 'mEdit could not be reached.' });
    expect(feed.rows.readFailureMessage()).toBe("Failed to load: mEdit's facts about each plugin: mEdit could not be reached.");
  });

  it.each([
    ['re-read', (feed: PluginFactsFeed) => feed.refresh()],
    ['hand-off', (feed: PluginFactsFeed) => feed.reconciled([])],
  ] as const)('a failed %s that mEdit going away superseded leaves the rows to the disconnect', async (_read, read) => {
    const { feed, client } = feedOver();
    client.setQueryFailure('getPlugins', { failed: 'unreachable' });

    const reading = read(feed);
    feed.unreachable('mEdit is disconnected.');
    await reading;

    expect(feed.rows.readFailureMessage()).toBeUndefined();
    expect(feed.rows.expansion(A)).toEqual({ kind: 'error', message: 'mEdit is disconnected.' });
  });

  it('drops a reconcile answer that lands after a newer event', async () => {
    const { feed, client } = feedOver();
    client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true })]);
    const landing = feed.reconciled([]);
    feed.indexed([], []);

    expect(await landing).toBeUndefined();
    expect(compiledPluginFlag(feed)).toBe(false);
  });

  it('a fact re-read during a reconcile hand-off leaves the hand-off standing', async () => {
    const { feed, client } = feedOver();
    const slow = deferred<PluginMetadata[]>();
    client.setQueryAnswerOnce('getPlugins', slow.promise);
    client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: true })]);
    const handOff = feed.reconciled([]);
    await feed.refresh();
    slow.resolve([held({ isCompiledPlugin: true })]);

    expect(await handOff).toEqual({ held: 1, active: 0, rowsGone: [] });
    expect(compiledPluginFlag(feed)).toBe(true);
  });

  it('a later re-read lands over an earlier one still in flight', async () => {
    const { feed, client } = feedOver();
    const slow = deferred<PluginMetadata[]>();
    client.setQueryAnswerOnce('getPlugins', slow.promise);
    client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: false })]);
    const earlier = feed.refresh();
    const later = feed.refresh();
    slow.resolve([held({ isCompiledPlugin: true })]);
    await Promise.all([earlier, later]);

    expect(compiledPluginFlag(feed)).toBe(false);
  });

  it('publishes the malformed-plugin scan to the Problems panel', async () => {
    const { feed, client, diagnoses } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', [diagnosis('first')]);
    const published = diagnoses.next();

    await feed.reconciled([]);
    await published;

    expect(diagnoses.items).toEqual([[diagnosis('first')]]);
    expect(feed.rows.description(A)).toBe('malformed');
  });

  it('a failed scan leaves the last answer', async () => {
    const { feed, client, diagnoses } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '503' });

    await feed.reconciled([]);
    await vi.waitFor(() => { expect(feed.rows.readFailureMessage()).toContain('503'); });

    expect(diagnoses.items).toEqual([]);
  });

  it('keeps the last diagnoses on the rows when the next scan fails', async () => {
    const { feed, client } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', [diagnosis('first')]);
    await feed.reconciled([]);
    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '503' });

    await feed.reconciled([]);
    await vi.waitFor(() => { expect(feed.rows.readFailureMessage()).toContain('503'); });

    expect(feed.rows.description(A)).toBe('malformed');
  });

  it('records a failed scan on the rows and fires a change, and the next answer clears it', async () => {
    const { feed, client, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', []);
    client.setQueryFailureOnce('getDiagnoses', { failed: 'refused', refusal: '503' });
    await feed.reconciled([]);
    await vi.waitFor(() => { expect(feed.rows.readFailureMessage()).toContain('503'); });

    const before = changes.mock.calls.length;
    await feed.reconciled([]);
    await vi.waitFor(() => { expect(changes.mock.calls.length).toBeGreaterThan(before + 1); });

    expect(feed.rows.readFailureMessage()).toBeUndefined();
  });

  it('drops a failed scan that a newer event superseded, and changes no facts', async () => {
    const { feed, client, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    const slowScan = deferred<PluginDiagnosisReport[] | ReadFailed>();
    client.setQueryAnswerOnce('getDiagnoses', slowScan.promise);
    await feed.reconciled([]);
    feed.unreachable('gone');
    const before = changes.mock.calls.length;

    slowScan.resolve({ failed: 'refused', refusal: 'late' });
    await feed.refresh();

    expect(changes.mock.calls.length).toBe(before + 1);
    expect(feed.rows.readFailureMessage()).toBeUndefined();
  });

  it('drops a scan answer that lands after a newer event', async () => {
    const { feed, client, diagnoses } = feedOver();
    const slowScan = deferred<PluginDiagnosisReport[]>();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswerOnce('getDiagnoses', slowScan.promise);
    await feed.reconciled([]);
    feed.indexed([], []);

    slowScan.resolve([diagnosis('stale')]);
    await feed.refresh();

    expect(diagnoses.items).toEqual([]);
    expect(feed.rows.description(A)).toBeUndefined();
  });

  describe('a throw that is no failed read', () => {
    it('is not folded into the unreadable-plugin-list rows, and reaches the caller', async () => {
      const { feed, client } = feedOver({ shownPlugins: () => { throw new Error('the tree broke'); } });
      client.setQueryAnswer('getPlugins', [held()]);

      await expect(feed.reconciled([])).rejects.toThrow('the tree broke');
      expect(feed.rows.readFailureMessage()).toBeUndefined();
    });

    it('is not folded into a failed scan on the rows, and is left unhandled', async () => {
      const { feed, client } = feedOver({ publishDiagnoses: () => { throw new Error('the Problems panel broke'); } });
      client.setQueryAnswer('getPlugins', [held()]);
      client.setQueryAnswer('getDiagnoses', []);

      const thrown = await nextUnhandledRejection(() => feed.reconciled([]));

      expect(thrown).toEqual(new Error('the Problems panel broke'));
      expect(feed.rows.readFailureMessage()).toBeUndefined();
    });
  });

  it.each([
    ['a reconcile', (feed: PluginFactsFeed) => feed.reconciled([])],
    ['a facts re-read', (feed: PluginFactsFeed) => feed.refresh()],
  ])('publishes a plugin whose plugin source is unreadable to the Problems panel on %s', async (_what, read) => {
    const { feed, client, sourceUnreadable } = feedOver();
    client.setQueryAnswer('getPlugins', [held({ pluginSourceUnreadable: { reason: 'Its folder is gone.', decompileRepairs: true } })]);

    await read(feed);

    expect(sourceUnreadable.items.map((entries) => entries.map(({ plugin, origin }) => ({ plugin, origin })))).toEqual([[{ plugin: 'A.esp', origin: 'SomeMod' }]]);
  });

  it('publishes a plugin mEdit never opened and says changed outside, which no row of its facts names', async () => {
    const { feed, client, changedOutside } = feedOver();
    client.setQueryAnswer('getPlugins', []);
    client.setQueryAnswer('getPluginsIndexing', [{ name: 'Never.esp', origin: 'SomeMod', state: 'Failed', reason: 'truncated', changedOutside: true }]);

    await feed.refresh();

    expect(changedOutside.items.at(-1)?.map(({ plugin, origin }) => ({ plugin, origin }))).toEqual([{ plugin: 'Never.esp', origin: 'SomeMod' }]);
  });

  it.each([
    ['a facts re-read', (feed: PluginFactsFeed) => feed.refresh()],
    ['a reconcile', (feed: PluginFactsFeed) => feed.reconciled([])],
  ])('publishes the plugin mEdit says changed outside, to the Problems panel on %s', async (_what, read) => {
    const { feed, client, changedOutside } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getPluginsIndexing', [{ name: 'A.esp', origin: 'SomeMod', state: 'Indexed', changedOutside: true }]);

    await read(feed);

    expect(changedOutside.items.at(-1)?.map(({ plugin, origin }) => ({ plugin, origin }))).toEqual([{ plugin: 'A.esp', origin: 'SomeMod' }]);
  });
});
