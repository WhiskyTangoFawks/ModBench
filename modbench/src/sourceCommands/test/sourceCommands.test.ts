import { describe, it, expect } from 'vitest';
import { InMemoryMEditClient } from '../../client/test/InMemoryMEditClient';
import { sourceCommands } from '../sourceCommands';

describe('sourceCommands build', () => {
  it('fires mEdit\'s build with the mods and hands back its outcome', async () => {
    const client = new InMemoryMEditClient();
    const outcome = { landed: [{ mod: 'ModA', compiled: [], refused: [] }], refused: [] };
    client.setCommandResult('build', outcome);

    const result = await sourceCommands({ client }).build(['ModA', 'ModB']);

    expect(client.calls).toEqual([{ method: 'build', args: [['ModA', 'ModB']] }]);
    expect(result).toEqual(outcome);
  });
});
