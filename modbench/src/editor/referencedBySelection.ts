import * as vscode from 'vscode';
import { openedRow, type ReferencedByRow } from './referencedByList';

/** The selection of VS Code's References view, which a key cannot read from a view another
 *  extension owns: the row last opened by a click or Enter, until the next list replaces it. */
export class ReferencedBySelection implements vscode.Disposable {
  private opened: readonly ReferencedByRow[] = [];
  private readonly changed = new vscode.EventEmitter<{ readonly selection: readonly ReferencedByRow[] }>();
  readonly onDidChangeSelection = this.changed.event;

  get selection(): readonly ReferencedByRow[] {
    return this.opened;
  }

  /** Called with what an open command was handed. */
  opening(invocation: unknown): void {
    const row = openedRow(invocation);
    if (row) this.set([row]);
  }

  clear(): void {
    this.set([]);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private set(rows: readonly ReferencedByRow[]): void {
    this.opened = rows;
    this.changed.fire({ selection: rows });
  }
}
