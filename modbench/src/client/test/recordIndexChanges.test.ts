import { describe, it, expect } from 'vitest';
import type { MEditClient, RecordIndexChange } from '..';
import { loadOrderStatusEventFixture } from './fixtures';
import { fakeMEdit, runningMEdit } from './fakeMEdit';
import { answered } from './healthAnswer';

function heard(client: MEditClient): RecordIndexChange[] {
  const changes: RecordIndexChange[] = [];
  client.onDidChange((change) => changes.push(change));
  return changes;
}

const rows = { kind: 'rows-changed', plugin: 'A.esp', origin: 'Mod', keys: ['0001:A.esp'], sequence: 1 };

describe('the client\'s one change event', () => {
  it('names the plugin and the record keys of rows changed', async () => {
    const { client, fire } = await runningMEdit();
    const changes = heard(client);

    await fire(rows);

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' }, keys: ['0001:A.esp'] }]]);
  });

  it('names the plugin alone for plugin changed', async () => {
    const { client, fire } = await runningMEdit();
    const changes = heard(client);

    await fire({ ...rows, kind: 'plugin-changed', keys: [] });

    expect(changes).toEqual([[{ plugin: { name: 'A.esp', origin: 'Mod' } }]]);
  });

  it('says everything when mEdit says the record index changed', async () => {
    const { client, fire } = await runningMEdit();
    const changes = heard(client);

    await fire({ ...rows, kind: 'record-index-changed', plugin: '', origin: '', keys: [] });

    expect(changes).toEqual([undefined]);
  });

  it('says everything when a load order settles', async () => {
    const { client, fire } = await runningMEdit();
    const changes = heard(client);

    await fire(loadOrderStatusEventFixture({ conflictsComputed: true, version: 1 }));

    expect(changes).toEqual([undefined]);
  });

  it('says everything when the stream reopens', async () => {
    const { client, reopen } = await runningMEdit();
    const changes = heard(client);

    await reopen();

    expect(changes).toEqual([undefined]);
  });

  it('says everything each time mEdit runs, the first included', async () => {
    const mEdit = fakeMEdit();
    const changes = heard(mEdit.client);

    await mEdit.start();
    expect(changes).toEqual([undefined]);

    await mEdit.exit();
    await mEdit.start();
    expect(changes).toEqual([undefined, undefined]);
  });

  it('says nothing for a launch that fails, through starting, disconnected and stopped', async () => {
    const { client } = fakeMEdit({ backend: { pollTimeoutMs: 0, checkHealth: () => Promise.resolve(answered(false)) } });
    const statuses: string[] = [];
    client.onStatusChanged((status) => statuses.push(status));
    const changes = heard(client);

    await client.start();

    expect({ statuses, changes }).toEqual({ statuses: ['starting', 'disconnected', 'stopped'], changes: [] });
  });

  it('stops telling a listener that was disposed', async () => {
    const { client, fire } = await runningMEdit();
    const changes: RecordIndexChange[] = [];
    const subscription = client.onDidChange((change) => changes.push(change));

    subscription.dispose();
    await fire(rows);

    expect(changes).toEqual([]);
  });
});
