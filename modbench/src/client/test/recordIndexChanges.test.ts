import { describe, it, expect, vi } from 'vitest';
import type { BackendStatus, RecordIndexChange } from '../MEditClient';
import { InMemoryMEditClient } from './InMemoryMEditClient';
import { EMPTY_SNAPSHOT, loadOrderStatusEventFixture } from './fixtures';

function heard(client: InMemoryMEditClient): RecordIndexChange[] {
  const changes: RecordIndexChange[] = [];
  client.onDidChange((change) => changes.push(change));
  return changes;
}

const rows = { kind: 'rows-changed', plugin: 'A.esp', origin: 'Mod', keys: ['0001:A.esp'], sequence: 1 };

describe('the client\'s one change event', () => {
  it('names the plugin and the record keys of rows changed', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.emit(rows);

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' }, keys: ['0001:A.esp'] }]]);
  });

  it('names the plugin alone for plugin changed', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.emit({ ...rows, kind: 'plugin-changed', keys: [] });

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' } }]]);
  });

  it('says everything when mEdit says the record index changed', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.emit({ ...rows, kind: 'record-index-changed', plugin: '', origin: '', keys: [] });

    expect(changes).toEqual([undefined]);
  });

  it('says everything when a load order settles', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.emit(loadOrderStatusEventFixture({ conflictsComputed: true, version: 1 }));

    expect(changes).toEqual([undefined]);
  });

  it('says everything when the stream reopens', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.reconnected();

    expect(changes).toEqual([undefined]);
  });

  it('says everything each time mEdit runs, the first included', () => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.setStatus('running');
    expect(changes).toEqual([undefined]);

    client.setStatus('disconnected');
    client.setStatus('running');
    expect(changes).toEqual([undefined, undefined]);
  });

  it.each<BackendStatus>(['starting', 'disconnected', 'stopped'])('says nothing for a status alone: %s', (status) => {
    const client = new InMemoryMEditClient();
    const changes = heard(client);

    client.setStatus(status);
    client.emit(loadOrderStatusEventFixture({ conflictsComputed: false, version: 1 }));

    expect(changes).toEqual([]);
  });

  it('stops telling a listener that was disposed', () => {
    const client = new InMemoryMEditClient();
    const changes: RecordIndexChange[] = [];
    const subscription = client.onDidChange((change) => changes.push(change));

    subscription.dispose();
    client.emit(rows);

    expect(changes).toEqual([]);
  });
});

describe('whether the record index may be late', () => {
  it('is false when nothing is handed over', () => {
    expect(new InMemoryMEditClient().recordIndexMayBeLate).toBe(false);
  });

  it('is true from a snapshot handed until mEdit has answered it', async () => {
    const client = new InMemoryMEditClient();
    client.setStatus('running');
    let answer!: () => void;
    client.answerPuts(() => new Promise((resolve) => { answer = () => { resolve({ outcome: 'abandoned' }); }; }));

    const sent = client.sendLoadOrder(EMPTY_SNAPSHOT);
    expect(client.recordIndexMayBeLate).toBe(true);

    answer();
    await sent;
    await vi.waitFor(() => { expect(client.recordIndexMayBeLate).toBe(false); });
  });
});
