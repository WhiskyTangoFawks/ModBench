import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from '../../modmanager/test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createOverwriteWatcher } from '../overwriteWatcher';
import { present } from '../../ports/present';

describe('createOverwriteWatcher', () => {
  it('watches overwrite/** under the instance root', () => {
    watchers.length = 0;

    createOverwriteWatcher('/instance', () => {});

    expect(present(watchers[0], 'the watcher createOverwriteWatcher registers').pattern).toBe('overwrite/**');
  });
});
