import { describe, it, expect, vi } from 'vitest';
import { offerEslFlagRemoval } from '../eslFlagRemovalPrompt';
import type { PluginRepository } from '../PluginRepository';

function repositoryWith(editRecordField: PluginRepository['editRecordField']): PluginRepository {
  return { editRecordField } as unknown as PluginRepository;
}

const TARGET = { name: 'MyPatch.esp', origin: 'ModA' };

describe('offerEslFlagRemoval (#290)', () => {
  it('declining the modal (Esc/Cancel) does not edit the flag and returns false', async () => {
    const editRecordField = vi.fn();
    const showWarning = vi.fn().mockResolvedValue(undefined);
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Create the Record', repositoryWith(editRecordField), showWarning, showError,
    );

    expect(accepted).toBe(false);
    expect(editRecordField).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('accepting removes the header is_light flag and returns true', async () => {
    const editRecordField = vi.fn().mockResolvedValue({ applied: true });
    const showWarning = vi.fn().mockResolvedValue('Remove ESL Flag and Create the Record');
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Create the Record', repositoryWith(editRecordField), showWarning, showError,
    );

    expect(accepted).toBe(true);
    expect(editRecordField).toHaveBeenCalledWith(
      '000000:MyPatch.esp', 'MyPatch.esp', 'ModA', 'is_light', false,
    );
    expect(showError).not.toHaveBeenCalled();
  });

  it('the modal names the retried gesture in both its accept button and its own text', async () => {
    const showWarning = vi.fn().mockResolvedValue(undefined);

    await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Copy the Record', repositoryWith(vi.fn()), showWarning, vi.fn(),
    );

    expect(showWarning).toHaveBeenCalledWith(
      expect.stringContaining('Remove the ESL flag and copy the record?'),
      { modal: true },
      'Remove ESL Flag and Copy the Record',
    );
  });

  it('an accepted edit that is itself refused shows the refusal and returns false, never a silent no-op', async () => {
    const editRecordField = vi.fn().mockResolvedValue({ applied: false, refusal: 'PluginNotTracked', message: 'not tracked' });
    const showWarning = vi.fn().mockResolvedValue('Remove ESL Flag and Compile');
    const showError = vi.fn();

    const accepted = await offerEslFlagRemoval(
      TARGET, 'exhausted the ESL range', 'Compile', repositoryWith(editRecordField), showWarning, showError,
    );

    expect(accepted).toBe(false);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining('not tracked'));
  });
});
