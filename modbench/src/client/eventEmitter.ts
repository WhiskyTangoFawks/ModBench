/** Structurally a `vscode.Disposable`. */
export interface Disposable { dispose(): void }

/** VS Code's `EventEmitter` shape without its import: `event` subscribes, `fire` tells every listener, and `dispose`
 *  drops them all. */
export class EventEmitter<T = void> {
  private readonly listeners = new Set<(data: T) => void>();

  readonly event = (listener: (data: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) listener(data);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
