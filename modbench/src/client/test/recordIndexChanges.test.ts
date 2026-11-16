import { describe, it, expect } from 'vitest';
import type { BackendStatus, RecordIndexChange } from '../MEditClient';
import { loadOrderStatusEventFixture } from './fixtures';
import { keepers } from './keepers';

function heard(client: ReturnType<typeof keepers>): RecordIndexChange[] {
  const changes: RecordIndexChange[] = [];
  client.onDidChange((change) => changes.push(change));
  return changes;
}

const rows = { kind: 'rows-changed', plugin: 'A.esp', origin: 'Mod', keys: ['0001:A.esp'], sequence: 1 };

describe('the client\'s one change event', () => {
  it('names the plugin and the record keys of rows changed', () => {
    const client = keepers();
    const changes = heard(client);

    client.fire(rows);

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' }, keys: ['0001:A.esp'] }]]);
  });

  it('names the plugin alone for plugin changed', () => {
    const client = keepers();
    const changes = heard(client);

    client.fire({ ...rows, kind: 'plugin-changed', keys: [] });

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' } }]]);
  });

  it('says everything when mEdit says the record index changed', () => {
    const client = keepers();
    const changes = heard(client);

    client.fire({ ...rows, kind: 'record-index-changed', plugin: '', origin: '', keys: [] });

    expect(changes).toEqual([undefined]);
  });

  it('says everything when a load order settles', () => {
    const client = keepers();
    const changes = heard(client);

    client.fire(loadOrderStatusEventFixture({ conflictsComputed: true, version: 1 }));

    expect(changes).toEqual([undefined]);
  });

  it('says everything when the stream reopens', () => {
    const client = keepers();
    const changes = heard(client);

    client.reconnected();

    expect(changes).toEqual([undefined]);
  });

  it('says everything each time mEdit runs, the first included', () => {
    const client = keepers();
    const changes = heard(client);

    client.setStatus('running');
    expect(changes).toEqual([undefined]);

    client.setStatus('disconnected');
    client.setStatus('running');
    expect(changes).toEqual([undefined, undefined]);
  });

  it.each<BackendStatus>(['starting', 'disconnected', 'stopped'])('says nothing for a status alone: %s', (status) => {
    const client = keepers();
    const changes = heard(client);

    client.setStatus(status);
    client.fire(loadOrderStatusEventFixture({ conflictsComputed: false, version: 1 }));

    expect(changes).toEqual([]);
  });

  it('stops telling a listener that was disposed', () => {
    const client = keepers();
    const changes: RecordIndexChange[] = [];
    const subscription = client.onDidChange((change) => changes.push(change));

    subscription.dispose();
    client.fire(rows);

    expect(changes).toEqual([]);
  });
});
