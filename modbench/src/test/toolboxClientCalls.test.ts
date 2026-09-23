import { describe, it, expect } from 'vitest';
import { implicitMastersFrom } from '../toolboxClientCalls';
import { InMemoryMEditClient } from '../client';

describe('implicitMastersFrom', () => {
  it('calls the port with the folder and the resolved game release', async () => {
    const client = new InMemoryMEditClient();
    client.setQueryAnswer('implicitMasters', ['Fallout4.esm', 'DLCRobot.esm']);

    const result = await implicitMastersFrom(client, '/game/Data', 'Fallout4');

    expect(client.calls).toContainEqual({ method: 'implicitMasters', args: ['/game/Data', 'Fallout4'] });
    expect(result).toEqual(['Fallout4.esm', 'DLCRobot.esm']);
  });

  it('answers undefined without calling the port when the folder is unresolved', async () => {
    const client = new InMemoryMEditClient();

    const result = await implicitMastersFrom(client, undefined, 'Fallout4');

    expect(client.calls).toEqual([]);
    expect(result).toBeUndefined();
  });

  it('answers undefined without calling the port when the game has no Mutagen release', async () => {
    const client = new InMemoryMEditClient();

    const result = await implicitMastersFrom(client, '/game/Data', undefined);

    expect(client.calls).toEqual([]);
    expect(result).toBeUndefined();
  });
});
