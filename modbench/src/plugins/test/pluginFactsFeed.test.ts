import { describe, it, expect, vi } from 'vitest';
import type { PluginAddress, PluginDiagnosisReport, PluginMetadata } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import type { ReadFailed } from '../../wire/readFailed';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { PluginFactsFeed, type PluginFactsFeedDeps } from '../pluginFactsFeed';
import { rulesReader, type SortingRuleFiles } from '../../sortingRules/lootMetadata';

const USERLIST = '/instance/userlist.yaml';
const filesWith = (masterlist: string, userlist = ''): SortingRuleFiles => ({
  masterlist: { path: '/instance/masterlist.yaml', kind: 'text', text: masterlist },
  prelude: { path: '/instance/prelude.yaml', kind: 'absent' },
  userlist: userlist === '' ? { path: USERLIST, kind: 'absent' } : { path: USERLIST, kind: 'text', text: userlist },
});
const rulesOf = (files: SortingRuleFiles, present: readonly string[] = []): ReturnType<PluginFactsFeedDeps['rules']> =>
  ({ ...rulesReader()(files), isPresent: (filename) => present.includes(filename) });
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
}

function feedOver({ shownPlugins = () => [A], activePlugins = () => [], publishDiagnoses, rules = () => NO_RULES }: FeedOptions = {}) {
  const client = clientFindingNoDefects();
  const diagnoses = watched<readonly PluginDiagnosisReport[]>();
  const changedOutside = watched<readonly { plugin: string; origin: string }[]>();
  const sourceUnreadable = watched<readonly { plugin: string; origin: string }[]>();
  const sortingErrors = watched<readonly { plugin: string; origin: string; text: string }[]>();
  const sortingInfo = watched<readonly { plugin: string; origin: string; text: string }[]>();
  const ruleFiles = watched<readonly { path: string; line: number; level: string; text: string }[]>();
  const feed = new PluginFactsFeed({
    client, shownPlugins, activePlugins, rules, holdsLine: () => true,
    publishSortingInfo: sortingInfo.push,
    publishRuleFiles: ruleFiles.push,
    publishDiagnoses: publishDiagnoses ?? diagnoses.push,
    publishChangedOutside: changedOutside.push,
    publishFailedToRead: () => undefined,
    publishSourceUnreadable: sourceUnreadable.push,
    publishSortingErrors: sortingErrors.push,
    publishSortingWarnings: () => undefined,
  });
  const changes = vi.fn();
  feed.onDidChange(changes);
  return { feed, client, diagnoses, changedOutside, sourceUnreadable, sortingErrors, sortingInfo, ruleFiles, changes };
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

    expect(await feed.reconciled([])).toBe(1);

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

  it('publishes a rule the userlist states on its line in the userlist', async () => {
    const rules = rulesOf(filesWith('plugins: []\n', 'plugins:\n  - name: A.esp\n    inc: [B.esp]\n'), ['B.esp']);
    const { feed, client, ruleFiles } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);

    await feed.reconciled([]);

    expect(ruleFiles.items).toEqual([[{ path: USERLIST, line: 2, level: 'error', text: '"A.esp" is incompatible with "B.esp", which is present.' }]]);
  });

  it('judges the order of the last reconcile again when the rules change, and not before one', async () => {
    let rules = NO_RULES;
    const { feed, client, sortingErrors } = feedOver({ activePlugins: () => [A], rules: () => rules });
    client.setQueryAnswer('getPlugins', [held()]);
    rules = rulesOf(filesWith('plugins:\n  - name: A.esp\n    req: [Missing.esp]\n'));
    feed.rulesChanged();
    const beforeReconcile = sortingErrors.items.length;

    await feed.reconciled([]);
    rules = NO_RULES;
    feed.rulesChanged();

    expect([beforeReconcile, sortingErrors.items.map((errors) => errors.length)]).toEqual([0, [1, 0]]);
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

    expect(await handOff).toBe(1);
    expect(compiledPluginFlag(feed)).toBe(true);
  });

  it('a later re-read wins over an earlier one still in flight', async () => {
    const { feed, client } = feedOver();
    const slow = deferred<PluginMetadata[]>();
    client.setQueryAnswerOnce('getPlugins', slow.promise);
    client.setQueryAnswer('getPlugins', [held({ isCompiledPlugin: false })]);
    const earlier = feed.refresh();
    await feed.refresh();
    slow.resolve([held({ isCompiledPlugin: true })]);
    await earlier;

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

  it('takes the external-change notification itself: publishes A\'s warning and fires the change event', () => {
    const { client, changedOutside, changes } = feedOver();

    client.emit({ kind: 'external-change', plugin: '', origin: 'SomeMod', keys: [], sequence: 0, changedPlugins: [{ name: 'A.esp', bytesSha256: 'ab12' }] });

    expect(changedOutside.items.map((warnings) => warnings.map(({ plugin, origin }) => ({ plugin, origin })))).toEqual([[{ plugin: 'A.esp', origin: 'SomeMod' }]]);
    expect(changes).toHaveBeenCalledOnce();
  });

  it('stops listening for the notification once disposed', () => {
    const { feed, client, changes } = feedOver();
    feed.dispose();

    client.emit({ kind: 'external-change', plugin: '', origin: 'SomeMod', keys: [], sequence: 0, changedPlugins: [] });

    expect(changes).not.toHaveBeenCalled();
  });
});
