/** Structurally a `vscode.Disposable`. */
export interface Disposable { dispose(): void }

/** VS Code's `EventEmitter` shape without its import: `event` subscribes, `fire` tells every listener, and `dispose`
 *  drops them all. */
export class EventEmitter<A extends unknown[] = []> {
  private readonly listeners = new Set<(...args: A) => void>();

  readonly event = (listener: (...args: A) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(...args: A): void {
    for (const listener of [...this.listeners]) listener(...args);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
