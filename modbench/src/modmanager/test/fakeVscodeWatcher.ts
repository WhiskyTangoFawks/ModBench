// Shared fake for the fs-watcher unit tests (fsWatcher.test.ts, modsWatcher.test.ts,
// overwriteWatcher.test.ts): a minimal stand-in for vscode.workspace.createFileSystemWatcher
// that records the RelativePattern it was constructed with, so a test can assert which glob a
// watcher was actually told to watch — an observable effect at the real vscode boundary,
// never a mock verifying a mock. One copy, so the three call sites share it rather than each
// re-declaring an identical `vi.mock('vscode', ...)` block.

export class FakeWatcher {
  disposed = false;
  private createHandlers: (() => void)[] = [];
  private changeHandlers: (() => void)[] = [];
  private deleteHandlers: (() => void)[] = [];
  constructor(public pattern: string) {}
  onDidCreate = (h: () => void) => { this.createHandlers.push(h); };
  onDidChange = (h: () => void) => { this.changeHandlers.push(h); };
  onDidDelete = (h: () => void) => { this.deleteHandlers.push(h); };
  fireCreate() { this.createHandlers.forEach((h) => h()); }
  fireChange() { this.changeHandlers.forEach((h) => h()); }
  fireDelete() { this.deleteHandlers.forEach((h) => h()); }
  dispose() { this.disposed = true; }
}

/** Every FakeWatcher a test's `createXWatcher(...)` call produced, in creation order. Callers
 *  reset it themselves (`watchers.length = 0`) between tests. */
export const watchers: FakeWatcher[] = [];

/** Pass to `vi.mock('vscode', () => fakeVscodeModule())` in each test file — a factory, not a
 *  shared instance, so vi.mock's own hoisting rules are respected. */
export function fakeVscodeModule() {
  return {
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    workspace: {
      createFileSystemWatcher: (pattern: { pattern: string }) => {
        const w = new FakeWatcher(pattern.pattern);
        watchers.push(w);
        return w;
      },
    },
  };
}
