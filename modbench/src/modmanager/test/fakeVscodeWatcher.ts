// Shared fake for the fs-watcher unit tests (fsWatcher.test.ts, modsWatcher.test.ts,
// overwriteWatcher.test.ts): a minimal stand-in for vscode.workspace.createFileSystemWatcher
// that records the RelativePattern it was constructed with, so a test can assert which glob a
// watcher was actually told to watch — an observable effect at the real vscode boundary,
// never a mock verifying a mock. One copy, so the three call sites share it rather than each
// re-declaring an identical `vi.mock('vscode', ...)` block.

// A default fsPath so every existing argument-free fireCreate()/fireChange()/fireDelete() call
// keeps working unchanged — only a test that cares about the path (the `.git`-boundary filter)
// needs to pass one.
const DEFAULT_FS_PATH = '/instance/test/file';

export class FakeWatcher {
  disposed = false;
  private createHandlers: ((uri: { fsPath: string }) => void)[] = [];
  private changeHandlers: ((uri: { fsPath: string }) => void)[] = [];
  private deleteHandlers: ((uri: { fsPath: string }) => void)[] = [];
  constructor(public pattern: string) {}
  onDidCreate = (h: (uri: { fsPath: string }) => void) => { this.createHandlers.push(h); };
  onDidChange = (h: (uri: { fsPath: string }) => void) => { this.changeHandlers.push(h); };
  onDidDelete = (h: (uri: { fsPath: string }) => void) => { this.deleteHandlers.push(h); };
  fireCreate(fsPath: string = DEFAULT_FS_PATH) { this.createHandlers.forEach((h) => h({ fsPath })); }
  fireChange(fsPath: string = DEFAULT_FS_PATH) { this.changeHandlers.forEach((h) => h({ fsPath })); }
  fireDelete(fsPath: string = DEFAULT_FS_PATH) { this.deleteHandlers.forEach((h) => h({ fsPath })); }
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
