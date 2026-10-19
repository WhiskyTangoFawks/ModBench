import { describe, it, expect, vi } from 'vitest';
import type { PluginAddress, PluginDiagnosisReport, PluginMetadata } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { PluginFactsFeed } from '../pluginFactsFeed';

const A = { name: 'A.esp', origin: 'SomeMod' };
const held = (overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const diagnosis = (text: string): PluginDiagnosisReport => (
  { plugin: 'A.esp', origin: 'SomeMod', defectClass: 'fixed-size-subrecord-short', message: text, text }
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

function feedOver(client = new InMemoryMEditClient(), shown: readonly PluginAddress[] = [A]) {
  const logged = watched<{ level: string; msg: string }>();
  const diagnoses = watched<readonly PluginDiagnosisReport[]>();
  const changedOutside = watched<readonly { plugin: string; origin: string }[]>();
  const feed = new PluginFactsFeed({
    client, shownPlugins: () => shown,
    log: (level, msg) => logged.push({ level, msg }),
    publishDiagnoses: diagnoses.push,
    publishChangedOutside: changedOutside.push,
    publishFailedToRead: () => undefined,
  });
  const changes = vi.fn();
  feed.onDidChange(changes);
  return { feed, client, logged, diagnoses, changedOutside, changes };
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

  it('names an unreadable plugin list on the rows and the message line, logs it as an error, and answers undefined', async () => {
    const { feed, client, logged } = feedOver();
    client.setQueryFailure('getPlugins', { failed: 'unreachable' });

    expect(await feed.reconciled([])).toBeUndefined();

    expect(feed.rows.expansion(A)).toEqual({ kind: 'error', message: 'mEdit could not be reached.' });
    expect(feed.rows.readFailureMessage()).toBe('Failed to load: the plugin list: mEdit could not be reached.');
    expect(logged.items.map((l) => l.level)).toEqual(['error']);
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

  it('a failed scan only warns and leaves the last answer', async () => {
    const { feed, client, logged, diagnoses } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '503' });
    const warned = logged.next();

    await feed.reconciled([]);
    await warned;

    expect(logged.items.map((l) => l.level)).toEqual(['warn']);
    expect(diagnoses.items).toEqual([]);
  });

  it('keeps the last diagnoses on the rows when the next scan fails', async () => {
    const { feed, client, logged } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', [diagnosis('first')]);
    await feed.reconciled([]);
    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '503' });
    const warned = logged.next();

    await feed.reconciled([]);
    await warned;

    expect(feed.rows.description(A)).toBe('malformed');
  });

  it('records a failed scan on the rows and fires a change, and the next answer clears it', async () => {
    const { feed, client, logged, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', []);
    client.setQueryFailureOnce('getDiagnoses', { failed: 'refused', refusal: '503' });
    const warned = logged.next();
    await feed.reconciled([]);
    await warned;

    expect(feed.rows.readFailureMessage()).toContain('503');

    const before = changes.mock.calls.length;
    await feed.reconciled([]);
    await vi.waitFor(() => { expect(changes.mock.calls.length).toBeGreaterThan(before + 1); });

    expect(feed.rows.readFailureMessage()).toBeUndefined();
  });

  it('logs a failed scan once, and again only when the reason changes', async () => {
    const { feed, client, logged, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '503' });
    const warned = logged.next();
    await feed.reconciled([]);
    await warned;
    const before = changes.mock.calls.length;
    await feed.reconciled([]);
    await vi.waitFor(() => { expect(changes.mock.calls.length).toBeGreaterThan(before + 1); });
    expect(logged.items).toHaveLength(1);

    client.setQueryFailure('getDiagnoses', { failed: 'refused', refusal: '500' });
    const changed = logged.next();
    await feed.reconciled([]);
    await changed;

    expect(logged.items).toHaveLength(2);
  });

  it('logs a failed scan that a newer event superseded, and changes no facts', async () => {
    const { feed, client, logged, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    const slowScan = deferred<PluginDiagnosisReport[]>();
    client.setQueryAnswerOnce('getDiagnoses', slowScan.promise);
    await feed.reconciled([]);
    feed.unreachable('gone');
    const before = changes.mock.calls.length;
    const warned = logged.next();

    slowScan.reject(new Error('late'));
    await warned;

    expect(logged.items.map((l) => l.level)).toEqual(['warn']);
    expect(changes.mock.calls.length).toBe(before);
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
    await slowScan.promise;

    expect(diagnoses.items).toEqual([]);
    expect(feed.rows.description(A)).toBeUndefined();
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

  describe('a later read that failed', () => {
    const failing = (message: string) => held({ laterReadFailure: [{ sourceRelativePath: 'A.esp/Npc.json', message }] });
    it('logs nothing of its own across reads, as mEdit logs the failure once', async () => {
      const { feed, client, logged } = feedOver();
      for (const answer of [failing('Unexpected end at 1.'), failing('Unexpected end at 2.'), held(), failing('Unexpected end at 3.')]) {
        client.setQueryAnswer('getPlugins', [answer]);
        await feed.refresh();
      }

      expect(logged.items).toEqual([]);
    });

    it('is on the rows after a refresh and gone after the next good read, with no notification', async () => {
      const { feed, client } = feedOver();
      client.setQueryAnswer('getPlugins', [failing('bad')]);
      await feed.refresh();
      expect(feed.rows.readFailureMessage()).toContain('bad');

      client.setQueryAnswer('getPlugins', [held()]);
      await feed.refresh();

      expect(feed.rows.readFailureMessage()).toBeUndefined();
    });
  });
});
