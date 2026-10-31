import { describe, expect, it } from 'vitest';
import { mEditState } from '../mEditState';

describe('what mEdit is doing, as the status bar and the agent say it', () => {
  it.each([
    ['starting', 'loading~spin', 'mEdit: Starting…'],
    ['running', 'plug', 'mEdit: Running'],
    ['disconnected', 'error', 'mEdit: Disconnected'],
    ['stopped', 'circle-slash', 'mEdit: Stopped'],
  ] as const)('says %s until the snapshot is indexed', (status, icon, text) => {
    expect(mEditState(status, undefined)).toEqual({ icon, text });
  });

  it('says Ready once the snapshot is indexed, counting the active plugins', () => {
    expect(mEditState('running', 2)).toEqual({ icon: 'check', text: 'mEdit: Ready (2 plugins)' });
  });
});
