import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { adapterOver } from '../../test/mo2/adapterOver';
import { instanceCommands } from '../instanceCommands';

describe('instanceCommands', () => {
  it('binds refresh to the mEdit client and the instance root, so a gesture passes only the game', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('rebuildIndex', { rebuilt: true });
    const commands = instanceCommands({ adapter: adapterOver('/instance'), client, instanceRoot: '/instance' });

    const result = await commands.refresh({ gameName: 'Fallout 4', gameRelease: 'Fallout4' });

    expect(client.calls.map((c) => [c.method, ...c.args])).toEqual([['rebuildIndex', '/instance', 'Fallout4']]);
    expect(result).toEqual({ applied: true });
  });

  it('binds switchProfile to the Instance adapter, so a gesture passes the profile and the profiles', async () => {
    const commands = instanceCommands({ adapter: adapterOver('/nowhere'), client: new InMemoryMEditClient(), instanceRoot: '/nowhere' });

    expect(await commands.switchProfile('Missing', ['Default'])).toEqual({ applied: false, refusal: 'No such profile: Missing' });
  });
});
