import * as vscode from 'vscode';

/** plugins.md, Pickers, Record filter: on any SQL document, saved or not, a lens that applies it
 *  as the record filter, or reads that it is the filter in force and clears it. */
export class FilterCodeLensProvider implements vscode.CodeLensProvider {
  private activeFilterSql: string | null = null;
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  setActiveSql(sql: string | null): void {
    this.activeFilterSql = sql;
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const isActive = this.activeFilterSql !== null && document.getText().trim() === this.activeFilterSql.trim();

    if (isActive) {
      return [new vscode.CodeLens(range, {
        title: '✓ Active — click to clear',
        command: 'modbench.record.clearFilter',
      })];
    }

    return [new vscode.CodeLens(range, {
      title: '▶ Apply as Filter',
      command: 'modbench.record.filter',
      arguments: [document.uri],
    })];
  }
}
