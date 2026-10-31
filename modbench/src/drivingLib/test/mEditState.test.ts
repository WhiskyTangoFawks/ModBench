import { describe, expect, it } from 'vitest';
import { mEditState } from '../mEditState';

describe('what mEdit is doing, as the status bar and the agent say it', () => {
  it.each([
    ['starting', 'loading~spin', 'Starting…'],
    ['running', 'plug', 'Running'],
    ['disconnected', 'error', 'Disconnected'],
    ['stopped', 'circle-slash', 'Stopped'],
  ] as const)('says %s until the snapshot is indexed', (status, icon, state) => {
    expect(mEditState(status, undefined)).toEqual({ icon, state });
  });

  it('says Ready once the snapshot is indexed, counting the active plugins', () => {
    expect(mEditState('running', 2)).toEqual({ icon: 'check', state: 'Ready (2 plugins)' });
  });
});
