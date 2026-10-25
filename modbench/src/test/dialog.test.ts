import { describe, it, expect, vi, beforeEach } from 'vitest';

const { showWarningMessage } = vi.hoisted(() => ({ showWarningMessage: vi.fn() }));
vi.mock('vscode', () => ({ window: { showWarningMessage } }));

import { askQuestion } from '../dialog';

describe('askQuestion', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('poses the question as a modal warning, with its detail and every button, and returns the answer', async () => {
    showWarningMessage.mockResolvedValue('First');

    const answer = await askQuestion('A question', { modal: true, detail: 'Its detail' }, 'First', 'Second');

    expect(showWarningMessage).toHaveBeenCalledWith('A question', { modal: true, detail: 'Its detail' }, 'First', 'Second');
    expect(answer).toBe('First');
  });
});
