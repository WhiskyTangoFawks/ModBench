import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchers, fakeVscodeModule } from './test/fakeVscodeWatcher';

vi.mock('vscode', () => fakeVscodeModule());

import { createDebouncedFsWatcher } from './fsWatcher';

describe('createDebouncedFsWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    watchers.length = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a burst of create/change/delete events into a single onChange call', () => {
    const onChange = vi.fn();
    createDebouncedFsWatcher('/instance', 'test/**', onChange);
    const watcher = watchers[0];

    watcher.fireCreate();
    watcher.fireChange();
    watcher.fireDelete();
    vi.runAllTimers();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('disposing the returned Disposable disposes the underlying watcher', () => {
    const disposable = createDebouncedFsWatcher('/instance', 'test/**', () => {});
    const watcher = watchers[0];
    expect(watcher.disposed).toBe(false);

    disposable.dispose();

    expect(watcher.disposed).toBe(true);
  });

  it('disposing before the debounce window elapses cancels the in-flight onChange', () => {
    const onChange = vi.fn();
    const disposable = createDebouncedFsWatcher('/instance', 'test/**', onChange);
    watchers[0].fireCreate();

    disposable.dispose();
    vi.runAllTimers();

    expect(onChange).not.toHaveBeenCalled();
  });
});
