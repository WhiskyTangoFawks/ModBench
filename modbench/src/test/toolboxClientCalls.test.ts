import { describe, it, expect } from 'vitest';
import { implicitMastersFrom, rebuildIndexVia, putLoadOrderVia } from '../toolboxClientCalls';
import { InMemoryMEditClient } from '../medit/client';

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

describe('rebuildIndexVia', () => {
  it('calls the port with the instance root, the failure callback and the game release', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', true);
    const onFailure = () => {};

    const result = await rebuildIndexVia(client, '/instance', onFailure, 'Fallout4');

    expect(client.calls).toContainEqual({ method: 'rebuildIndex', args: ['/instance', onFailure, 'Fallout4'] });
    expect(result).toBe(true);
  });
});

describe('putLoadOrderVia', () => {
  it('calls the port with the plugins, the data folder, the instance root and the game release', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { outcome: 'reconciled' as const, failures: [], crashRepairOffers: [] };
    client.setCommandResult('putLoadOrder', outcome);
    const plugins = [{ name: 'Fallout4.esm', path: '/game/Data/Fallout4.esm', origin: 'base', slot: 0, enabled: true, winning: true }];

    const result = await putLoadOrderVia(client, plugins, '/game/Data', '/instance', 'Fallout4');

    expect(client.calls).toContainEqual({ method: 'putLoadOrder', args: [plugins, '/game/Data', '/instance', 'Fallout4', undefined] });
    expect(result).toBe(outcome);
  });
});
