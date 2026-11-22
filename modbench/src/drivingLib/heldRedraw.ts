import * as vscode from 'vscode';

// common.md, A gesture that writes, story 1: nothing in a view changes until the gesture's read lands, while the read model
// stays current under it.
let writing = 0;
const held = new Map<object, () => void>();

/** Runs `work`, a gesture that writes, holding every view's redraw until the outermost one ends. */
export async function holdingRedraws<T>(work: () => Promise<T>): Promise<T> {
  writing++;
  try {
    return await work();
  } finally {
    writing--;
    if (writing === 0) {
      const draws = [...held.values()];
      held.clear();
      for (const draw of draws) draw();
    }
  }
}

/** Runs `draw` now, or once the gestures writing have ended; asked again while held, the newest stands. */
export function drawn(by: object, draw: () => void): void {
  if (writing === 0) draw();
  else held.set(by, draw);
}

/** Takes back the draw `by` asked while held, such as a view that closed. */
export function undrawn(by: object): void {
  held.delete(by);
}

/** A view's change event, which `drawn` holds: each row asked while held fires once, or the whole view once. */
export class RedrawEmitter<E> implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<E>();
  readonly event = this.emitter.event;
  private whole: { readonly row: E } | undefined;
  private rows: E[] = [];

  fire(row: E): void {
    if (row === undefined || row === null) this.whole = { row };
    else if (!this.rows.includes(row)) this.rows.push(row);
    drawn(this, () => { this.release(); });
  }

  dispose(): void {
    undrawn(this);
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
