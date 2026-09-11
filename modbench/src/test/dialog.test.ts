import { describe, it, expect, vi, beforeEach } from 'vitest';

// `askQuestion` is the one real adapter for ADR-0019's dialog seam. It imports the real 'vscode'
// module, so the seam it puts over `showWarningMessage` is only assertable behind this mock.
const { showWarningMessage } = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showWarningMessage } }));

import { askQuestion } from '../dialog';

describe('askQuestion', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('poses the question as a modal warning, with its detail and every button, and returns the answer', async () => {
    showWarningMessage.mockResolvedValue('Apply to working tree');

    const answer = await askQuestion(
      'MyMod', { modal: true, detail: 'Plugin(s) changed: MyMod.esp' },
      'Apply to working tree', 'Commit to main as new baseline');

    expect(showWarningMessage).toHaveBeenCalledWith(
      'MyMod', { modal: true, detail: 'Plugin(s) changed: MyMod.esp' },
      'Apply to working tree', 'Commit to main as new baseline');
    expect(answer).toBe('Apply to working tree');
  });

  it('asks a question that has no detail and a single button', async () => {
    showWarningMessage.mockResolvedValue('Deploy');

    const answer = await askQuestion('Never deployed here. Continue?', { modal: true }, 'Deploy');

    expect(showWarningMessage).toHaveBeenCalledWith('Never deployed here. Continue?', { modal: true }, 'Deploy');
    expect(answer).toBe('Deploy');
  });

  it('returns undefined when the user dismissed the modal', async () => {
    showWarningMessage.mockResolvedValue(undefined);

    expect(await askQuestion('MyMod', { modal: true }, 'Apply')).toBeUndefined();
  });
});
