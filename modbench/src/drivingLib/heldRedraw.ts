import * as vscode from 'vscode';

// common.md, A gesture that writes, story 1, for the view the gesture runs from; every other view follows the disk (A view,
// stories 2 and 14).
const holds = new Map<string, number>();
const held = new Map<object, { readonly view: string; readonly draw: () => void }>();

/** Holds `view`'s redraw until each hold on it is released. */
export function holdRedraws(view: string): void {
  holds.set(view, (holds.get(view) ?? 0) + 1);
}

/** Releases one hold on `view`; the last draws what it held. */
export function releaseRedraws(view: string): void {
  const left = (holds.get(view) ?? 1) - 1;
  if (left > 0) {
    holds.set(view, left);
    return;
  }
  holds.delete(view);
  for (const [by, { view: of, draw }] of [...held]) {
    if (of !== view) continue;
    held.delete(by);
    draw();
  }
}

// Runs `draw` now, or when the last hold on `view` is released; asked again while held, the newest stands.
function drawn(by: object, view: string, draw: () => void): void {
  if (holds.has(view)) held.set(by, { view, draw });
  else draw();
}

/** A view's change event, which a gesture from the view holds: each row asked while held fires once, or the whole view once. */
export class RedrawEmitter<E> implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<E>();
  readonly event = this.emitter.event;
  private whole: { readonly row: E } | undefined;
  private rows: E[] = [];

  constructor(private readonly view: string) {}

  fire(row: E): void {
    if (row === undefined || row === null) this.whole = { row };
    else if (!this.rows.includes(row)) this.rows.push(row);
    drawn(this, this.view, () => { this.release(); });
  }

  /** Fires `rows` now, held or not: a control the user changed shows the value again. */
  restore(rows: readonly E[]): void {
    for (const row of rows) this.emitter.fire(row);
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

/** A decoration provider's change event, which a gesture from the view it decorates holds: every file asked while held,
 *  each once, in one event. */
export class DecorationRedrawEmitter implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly event = this.emitter.event;
  private whole = false;
  private readonly uris = new Map<string, vscode.Uri>();

  constructor(private readonly view: string) {}

  fire(uris: vscode.Uri | vscode.Uri[] | undefined): void {
    if (uris === undefined) this.whole = true;
    else for (const uri of [uris].flat()) this.uris.set(uri.toString(), uri);
    drawn(this, this.view, () => { this.release(); });
  }

  dispose(): void {
    held.delete(this);
    this.emitter.dispose();
  }

  private release(): void {
    const uris = this.whole ? undefined : [...this.uris.values()];
    this.whole = false;
    this.uris.clear();
    this.emitter.fire(uris);
  }
}
