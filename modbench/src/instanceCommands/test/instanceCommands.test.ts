import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter, readingFixture } from '../../test/fakeInstanceAdapter';
import { instanceCommands } from '../instanceCommands';
import type { RefreshResult } from '../loadOrder';
import type { RebuildIndexOutcome } from '../../client/MEditClient';

describe('refresh', () => {
  const refreshOver = (client: InMemoryMEditClient, gameRelease = 'Fallout4') =>
    instanceCommands({ adapter: fakeInstanceAdapter(readingFixture({ gameRelease })).adapter, client, instanceRoot: '/instance' }).refresh;

  it.each([
    ['the release the adapter reads now', 'Fallout4'],
    ['another release the adapter reads now', 'Fallout4VR'],
  ])('rebuilds the record index for the instance and %s, so mEdit reads every plugin again against the load order it holds', async (_case, release) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });

    const result = await refreshOver(client, release)();

    expect(client.calls.map((c) => [c.method, ...c.args])).toEqual([['rebuildIndex', '/instance', release]]);
    expect(result).toEqual({ applied: true });
  });

  it.each<[string, RebuildIndexOutcome, RefreshResult]>([
    ['reports held-elsewhere by name, apart from the generic refusal every other failure gets', { rebuilt: false, heldElsewhere: true }, { applied: false, heldElsewhere: true }],
    ['returns the reason for every other refused rebuild', { rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' },
      { applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' }],
  ])('%s, and sends nothing but the rebuild', async (_case, answer, refused) => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', answer);

    expect(await refreshOver(client)()).toEqual(refused);
    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
  });

  it('returns a refusal, not a throw, when the release cannot be read', async () => {
    const adapter = { ...fakeInstanceAdapter().adapter, gameRelease: () => Promise.reject(new Error('ModOrganizer.ini is unreadable')) };
    const client = new InMemoryMEditClient();

    const result = await instanceCommands({ adapter, client, instanceRoot: '/instance' }).refresh();

    expect(result).toEqual({ applied: false, heldElsewhere: false, refusal: 'ModOrganizer.ini is unreadable' });
    expect(client.calls).toEqual([]);
  });
});
