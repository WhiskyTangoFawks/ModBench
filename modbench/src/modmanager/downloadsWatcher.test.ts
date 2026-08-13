import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createDownloadsWatcher } from './downloadsWatcher';

// Coalesce/dispose/dispose-before-window behavior is covered generically by
// fsWatcher.test.ts, which this delegates to (#319, following #320's pattern for
// modsWatcher.test.ts / overwriteWatcher.test.ts). Only the glob this watcher is
// responsible for is asserted here, at the real vscode boundary.
describe('createDownloadsWatcher', () => {
  it('watches downloads/** under the instance root', () => {
    watchers.length = 0;

    createDownloadsWatcher('/instance', () => {});

    expect(watchers[0].pattern).toBe('downloads/**');
  });
});
