import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', async () => {
  const { recordedWithProgress } = await import('../../test/recordedProgress');
  return { window: { withProgress: recordedWithProgress } };
});

import { progressSteps as steps } from '../../test/recordedProgress';
import { showProgressWhileLate } from '../lateProgress';

beforeEach(() => {
  steps.length = 0;
});

function lateInstance() {
  const listeners = new Set<() => void>();
  const instance = {
    mayBeLate: false,
    onMayBeLate: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
  };
  return {
    instance,
    become: (late: boolean) => {
      instance.mayBeLate = late;
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

describe('every view\'s progress while the instance may be late', () => {
  it('opens on each view when the instance may be late, and closes them when it is confirmed', async () => {
    const { instance, become } = lateInstance();
    showProgressWhileLate(instance, ['modbench.a', 'modbench.b']);

    become(true);
    expect(steps).toEqual(['progress opens on modbench.a', 'progress opens on modbench.b']);
    become(false);

    await vi.waitFor(() => { expect(steps.slice(2)).toEqual(['progress closes', 'progress closes']); });
  });

  it('opens at once for an instance that is late when it is shown, and stops listening when disposed', () => {
    const { instance, listening } = lateInstance();
    instance.mayBeLate = true;

    const shown = showProgressWhileLate(instance, ['modbench.a']);

    expect(steps).toEqual(['progress opens on modbench.a']);
    shown.dispose();
    expect(listening()).toBe(0);
  });
});
