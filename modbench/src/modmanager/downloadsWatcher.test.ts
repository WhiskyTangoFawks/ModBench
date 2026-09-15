import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createDownloadsWatcher } from './downloadsWatcher';

// Only the glob is asserted here; coalesce and dispose are covered generically elsewhere.
describe('createDownloadsWatcher', () => {
  it('watches downloads/** under the instance root', () => {
    watchers.length = 0;

    createDownloadsWatcher('/instance', () => {});

    expect(watchers[0]!.pattern).toBe('downloads/**');
  });
});
