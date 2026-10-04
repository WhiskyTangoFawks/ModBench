import { describe, it, expect, vi } from 'vitest';
import { reportPutOutcome } from '../loadOrderOutcome';
import type { LoadOrderProgress } from '../../client';

const readyStatus: LoadOrderProgress = {
  totalPlugins: 3, activePlugins: 2, version: 1, indexedPlugins: [], conflictsComputed: true, holdsNone: false, failures: [],
};
const applied = { outcome: 'applied' as const, status: readyStatus };


describe('reportPutOutcome', () => {
  it('shows a failed send\'s ready-to-show message verbatim', () => {
    const error = vi.fn();

    reportPutOutcome({ outcome: 'failed', message: 'Failed to send the load order — bad dir' }, { error });

    expect(error).toHaveBeenCalledWith('Failed to send the load order — bad dir');
  });

  it('says nothing for an abandoned send — a superseded or closed send owns no view', () => {
    const error = vi.fn();

    reportPutOutcome({ outcome: 'abandoned' }, { error });

    expect(error).not.toHaveBeenCalled();
  });

  it('says nothing for an applied send, whose reconcile is the narrator\'s to show', () => {
    const error = vi.fn();

    reportPutOutcome(applied, { error });

    expect(error).not.toHaveBeenCalled();
  });
});
