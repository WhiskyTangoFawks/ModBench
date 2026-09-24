import { describe, it, expect, vi } from 'vitest';
import { watchers, fakeVscodeModule } from '../../test/mo2/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createDownloadsWatcher } from '../downloadsWatcher';
import { present } from '../../ports/present';

// Only the base and glob are asserted here; coalesce and dispose are covered generically
// elsewhere.
describe('createDownloadsWatcher', () => {
  it('watches everything under the given folder, taking it as the base — not a glob relative to some other root', () => {
    watchers.length = 0;

    createDownloadsWatcher('/instance/downloads', () => {});

    const watcher = present(watchers[0], 'the watcher just created');
    expect(watcher.base).toBe('/instance/downloads');
    expect(watcher.pattern).toBe('**');
  });

  // downloads.md, Which files are rows, story 1: the resolved folder may lie entirely outside
  // the instance — the watch base is whatever it is given, with no instance-root assumption.
  it('watches a folder outside any instance root the same way', () => {
    watchers.length = 0;

    createDownloadsWatcher('/mnt/external/MyDownloads', () => {});

    expect(present(watchers[0], 'the watcher just created').base).toBe('/mnt/external/MyDownloads');
  });
});
