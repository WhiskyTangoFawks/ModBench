import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { watchers, FakeWatcher } = vi.hoisted(() => {
  class FakeWatcher {
    disposed = false;
    private createHandlers: (() => void)[] = [];
    private changeHandlers: (() => void)[] = [];
    private deleteHandlers: (() => void)[] = [];
    onDidCreate = (h: () => void) => { this.createHandlers.push(h); };
    onDidChange = (h: () => void) => { this.changeHandlers.push(h); };
    onDidDelete = (h: () => void) => { this.deleteHandlers.push(h); };
    fireCreate() { this.createHandlers.forEach((h) => h()); }
    fireChange() { this.changeHandlers.forEach((h) => h()); }
    fireDelete() { this.deleteHandlers.forEach((h) => h()); }
    dispose() { this.disposed = true; }
  }
  return { watchers: [] as InstanceType<typeof FakeWatcher>[], FakeWatcher };
});

vi.mock('vscode', () => ({
  RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: {
    createFileSystemWatcher: () => {
      const w = new FakeWatcher();
      watchers.push(w);
      return w;
    },
  },
}));

import { createOverwriteWatcher } from './overwriteWatcher';

describe('createOverwriteWatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('coalesces a burst of create/change/delete events into a single onChange call', () => {
    watchers.length = 0;
    const onChange = vi.fn();
    createOverwriteWatcher('/instance', onChange);
    const watcher = watchers[0];

    watcher.fireCreate();
    watcher.fireChange();
    watcher.fireDelete();
    vi.runAllTimers();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('disposing the returned Disposable disposes the underlying watcher', () => {
    watchers.length = 0;
    const disposable = createOverwriteWatcher('/instance', () => {});
    const watcher = watchers[0];
    expect(watcher.disposed).toBe(false);

    disposable.dispose();

    expect(watcher.disposed).toBe(true);
  });

  it('disposing before the debounce window elapses cancels the pending onChange', () => {
    watchers.length = 0;
    const onChange = vi.fn();
    const disposable = createOverwriteWatcher('/instance', onChange);
    watchers[0].fireCreate();

    disposable.dispose();
    vi.runAllTimers();

    expect(onChange).not.toHaveBeenCalled();
  });
});
