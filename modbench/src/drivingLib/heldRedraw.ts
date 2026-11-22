import * as vscode from 'vscode';

// common.md, A gesture that writes, story 1, for the view the gesture runs from; every other view follows the disk (A view,
// stories 2 and 14).
const writing = new Map<string, number>();
const held = new Map<object, () => void>();

/** Runs `work`, a gesture that writes from `view`, holding that view's redraw until the outermost gesture from it ends. */
export async function holdingRedraws<T>(view: string, work: () => Promise<T>): Promise<T> {
  writing.set(view, (writing.get(view) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const left = (writing.get(view) ?? 1) - 1;
    if (left > 0) writing.set(view, left);
    else {
      writing.delete(view);
      for (const [by, draw] of [...held]) {
        if (by instanceof RedrawEmitter && by.view !== view) continue;
        held.delete(by);
        draw();
      }
    }
  }
}

/** A view's change event, which a gesture from the view holds: each row asked while held fires once, or the whole view once. */
export class RedrawEmitter<E> implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<E>();
  readonly event = this.emitter.event;
  private whole: { readonly row: E } | undefined;
  private rows: E[] = [];

  constructor(readonly view: string) {}

  fire(row: E): void {
    if (row === undefined || row === null) this.whole = { row };
    else if (!this.rows.includes(row)) this.rows.push(row);
    if (writing.has(this.view)) held.set(this, () => { this.release(); });
    else this.release();
  }

  dispose(): void {
    held.delete(this);
    this.emitter.dispose();
  }

  private release(): void {
    const { whole, rows } = this;
    this.whole = undefined;
    this.rows = [];
    if (whole !== undefined) this.emitter.fire(whole.row);
    else for (const row of rows) this.emitter.fire(row);
  }
}
