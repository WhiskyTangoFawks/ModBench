import { describe, it, expect, vi } from 'vitest';
import type { PluginAddress, PluginMetadata } from '../../client';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { pluginMetadataFixture } from '../../client/test/fixtures';
import { EventEmitter } from '../../test/vscodeMock';

vi.mock('vscode', () => ({ EventEmitter }));

import { PluginFactsFeed } from '../pluginFactsFeed';

const A = { name: 'A.esp', origin: 'SomeMod' };
const held = (overrides: Partial<PluginMetadata> = {}) => pluginMetadataFixture({ name: 'A.esp', ...overrides });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function feedOver(client = new InMemoryMEditClient(), shown: readonly PluginAddress[] = [A]) {
  const logged: { level: string; msg: string }[] = [];
  const diagnoses: unknown[] = [];
  const changedOutside: unknown[] = [];
  const feed = new PluginFactsFeed({
    client, shownPlugins: () => shown,
    log: (level, msg) => logged.push({ level, msg }),
    publishDiagnoses: (reports) => diagnoses.push(reports),
    publishChangedOutside: (warnings) => changedOutside.push(warnings),
  });
  const changes = vi.fn();
  feed.onDidChange(changes);
  return { feed, client, logged, diagnoses, changedOutside, changes };
}

describe('PluginFactsFeed', () => {
  it('lands a reconcile: the plugins shown become queryable, the change event fires, and the count returns', async () => {
    const { feed, client, changes } = feedOver();
    client.setQueryAnswer('getPlugins', [held({ isTracked: true }), held({ name: 'Unshown.esp' })]);
    client.setQueryAnswer('getDiagnoses', []);

    expect(await feed.reconciled([])).toBe(1);

    expect(feed.rows.contextFlags(A)).toContain('tracked');
    expect(feed.rows.contextFlags({ name: 'Unshown.esp', origin: 'SomeMod' })).toEqual([]);
    expect(changes).toHaveBeenCalled();
  });

  it('names an unreadable plugin list on the rows, logs it as an error, and answers undefined', async () => {
    const { feed, client, logged } = feedOver();
    client.setQueryFailure('getPlugins', new Error('ECONNREFUSED'));

    expect(await feed.reconciled([])).toBeUndefined();

    expect(feed.rows.expansion(A)).toEqual({ kind: 'error', message: 'ECONNREFUSED' });
    expect(logged.map((l) => l.level)).toEqual(['error']);
  });

  it('drops a reconcile answer that lands after a newer event', async () => {
    const { feed, client } = feedOver();
    client.setQueryAnswer('getPlugins', [held({ isTracked: true })]);
    const landing = feed.reconciled([]);
    feed.indexed([], []);

    expect(await landing).toBeUndefined();
    expect(feed.rows.contextFlags(A)).toEqual([]);
  });

  it('publishes the malformed-plugin scan to the Problems panel, and a failed scan only warns', async () => {
    const { feed, client, diagnoses, logged } = feedOver();
    client.setQueryAnswer('getPlugins', [held()]);
    client.setQueryAnswer('getDiagnoses', []);
    await feed.reconciled([]);
    await settle();
    expect(diagnoses).toEqual([[]]);

    client.setQueryFailure('getDiagnoses', new Error('503'));
    await feed.reconciled([]);
    await settle();
    expect(diagnoses).toHaveLength(1);
    expect(logged.map((l) => l.level)).toEqual(['warn']);
  });

  it('takes the external-change notification itself: publishes the warning and fires the change event', () => {
    const { client, changedOutside, changes } = feedOver();

    client.emit({ kind: 'external-change', plugin: '', origin: 'SomeMod', keys: [], sequence: 0, changedPlugins: [{ name: 'A.esp', bytesSha256: 'ab12' }] });

    expect(changedOutside).toHaveLength(1);
    expect(changes).toHaveBeenCalledOnce();
  });

  it('a fact re-read leaves a reconcile hand-off standing', async () => {
    const { feed, client } = feedOver();
    let resolveSlow!: (plugins: PluginMetadata[]) => void;
    client.setQueryAnswerOnce('getPlugins', new Promise<PluginMetadata[]>((resolve) => { resolveSlow = resolve; }));
    client.setQueryAnswer('getPlugins', [held()]);
    const handOff = feed.reconciled([]);
    await feed.refresh();
    resolveSlow([held()]);

    expect(await handOff).toBe(1);
  });

  it('stops listening for the notification once disposed', () => {
    const { feed, client, changes } = feedOver();
    feed.dispose();

    client.emit({ kind: 'external-change', plugin: '', origin: 'SomeMod', keys: [], sequence: 0, changedPlugins: [] });

    expect(changes).not.toHaveBeenCalled();
  });
});
