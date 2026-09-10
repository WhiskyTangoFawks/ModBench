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

  // A mod's `.git` directory churns heavily without any of the load-order facts this watcher
  // relays ever changing (ADR-0041).
  it('ignores an event inside a mod\'s .git directory, while a sibling content event still fires', () => {
    const onChange = vi.fn();
    createDebouncedFsWatcher('/instance', 'mods/**', onChange);
    const watcher = watchers[0];

    watcher.fireChange('/instance/mods/Foo/.git/MEDIT_COMPILE_JOURNAL');
    vi.runAllTimers();
    expect(onChange).not.toHaveBeenCalled();

    watcher.fireCreate('/instance/mods/Foo/Foo.esp');
    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // The `.git` directory entry appearing or disappearing is itself a load-order-relevant change
  // callers need, even though everything inside an existing `.git` is filtered above.
  it('does not ignore the .git directory entry itself appearing or disappearing', () => {
    const onCreate = vi.fn();
    createDebouncedFsWatcher('/instance', 'mods/**', onCreate);
    watchers[0].fireCreate('/instance/mods/Foo/.git');
    vi.runAllTimers();
    expect(onCreate).toHaveBeenCalledTimes(1);

    const onDelete = vi.fn();
    createDebouncedFsWatcher('/instance', 'mods/**', onDelete);
    watchers[1].fireDelete('/instance/mods/Foo/.git');
    vi.runAllTimers();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  // A latency assertion, not a cycle-count one: removing the stacked wait does not by itself
  // change how many cycles a burst produces.
  it('debounceMs is overridable, so a caller with its own downstream debounce is not made to wait twice', () => {
    const onDefault = vi.fn();
    const onOverridden = vi.fn();
    createDebouncedFsWatcher('/instance', 'test/**', onDefault);
    createDebouncedFsWatcher('/instance', 'test/**', onOverridden, 0);

    watchers[0].fireCreate();
    watchers[1].fireCreate();
    vi.advanceTimersByTime(50);

    expect(onOverridden).toHaveBeenCalledTimes(1);
    expect(onDefault).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(onDefault).toHaveBeenCalledTimes(1);
  });
});
