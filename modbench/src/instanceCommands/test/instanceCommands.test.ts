import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { instanceCommands } from '../instanceCommands';

const GAME = { gameName: 'Fallout 4', gameRelease: 'Fallout4' };

describe('refresh', () => {
  const refreshOver = (client: InMemoryMEditClient) =>
    instanceCommands({ adapter: fakeInstanceAdapter().adapter, client, instanceRoot: '/instance' }).refresh;

  it('rebuilds the index for the instance, so mEdit reads every plugin again against the load order it holds, and sends nothing', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });

    const result = await refreshOver(client)(GAME);

    expect(client.calls.map((c) => [c.method, ...c.args])).toEqual([['rebuildIndex', '/instance', 'Fallout4']]);
    expect(result).toEqual({ applied: true });
  });

  it('sends nothing and reports held-elsewhere by name, apart from the generic refusal every other failure gets', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: true });

    const result = await refreshOver(client)(GAME);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: true });
  });

  it('sends nothing and returns the reason for every other refused rebuild', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', { rebuilt: false, heldElsewhere: false, detail: 'Failed to rebuild the store.' });

    const result = await refreshOver(client)(GAME);

    expect(client.calls.map((c) => c.method)).toEqual(['rebuildIndex']);
    expect(result).toEqual({ applied: false, heldElsewhere: false, refusal: 'Failed to rebuild the store.' });
  });
});
