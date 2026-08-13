import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createOverwriteWatcher } from './overwriteWatcher';

describe('createOverwriteWatcher', () => {
  it('watches overwrite/** under the instance root', () => {
    watchers.length = 0;

    createOverwriteWatcher('/instance', () => {});

    expect(watchers[0].pattern).toBe('overwrite/**');
  });
});
