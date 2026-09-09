import { describe, it, expect, vi } from 'vitest';
import { offerEslFlagRemoval } from '../eslFlagRemovalPrompt';
import { InMemoryMEditClient } from '../client';

const TARGET = { name: 'MyPatch.esp', origin: 'ModA' };

describe('offerEslFlagRemoval', () => {
  it('declining the modal (Esc/Cancel) does not edit the flag and returns false', async () => {
    const client = new InMemoryMEditClient();
    const showWarning = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Create the Record', client, showWarning, showError,
    );

    expect(accepted).toBe(false);
    expect(client.calls).toEqual([]);
    expect(showError).not.toHaveBeenCalled();
  });

  it('accepting clears the header IsSmallMaster member through the one envelope and returns true', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('editRecord', { applied: true });
    const showWarning = vi.fn().mockResolvedValue('Remove ESL Flag and Create the Record');
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Create the Record', client, showWarning, showError,
    );

    expect(accepted).toBe(true);
    expect(client.calls).toContainEqual({
      method: 'editRecord',
      args: ['000000:MyPatch.esp', 'MyPatch.esp', 'ModA', { op: 'set', path: [{ kind: 'member', name: 'IsSmallMaster' }], value: false }],
    });
    expect(showError).not.toHaveBeenCalled();
  });

  it('the modal names the retried gesture in both its accept button and its own text', async () => {
    const client = new InMemoryMEditClient();
    const showWarning = vi.fn().mockResolvedValue(undefined);

    await offerEslFlagRemoval(TARGET, 'exhausted the ESL range', 'Copy the Record', client, showWarning, vi.fn());

    expect(showWarning).toHaveBeenCalledWith(
      expect.stringContaining('Remove the ESL flag and copy the record?'),
      { modal: true },
      'Remove ESL Flag and Copy the Record',
    );
  });

  it('an accepted edit that is itself refused shows the refusal and returns false, never a silent no-op', async () => {
    const client = new InMemoryMEditClient();
    client.setCommandResult('editRecord', { applied: false, refusal: 'PluginNotTracked', message: 'not tracked' });
    const showWarning = vi.fn().mockResolvedValue('Remove ESL Flag and Compile');
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(TARGET, 'exhausted the ESL range', 'Compile', client, showWarning, showError);

    expect(accepted).toBe(false);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('not tracked'));
  });
});
