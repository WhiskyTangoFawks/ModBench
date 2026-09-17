// Keeps the RelativePattern it was built with, so a test can assert which glob a
// watcher was told to watch: an effect at the real vscode boundary.

// Only a test that cares about the path passes one.
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

/** In creation order. Callers reset it themselves between tests. */
export const watchers: FakeWatcher[] = [];

/** A factory, not a shared instance, so `vi.mock`'s hoisting rules are respected. */
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
