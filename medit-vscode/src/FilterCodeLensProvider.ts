import * as vscode from 'vscode';
import * as path from 'path';

export class FilterCodeLensProvider implements vscode.CodeLensProvider {
  private activeFilterSql: string | null = null;
  private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private readonly scriptsPath: string) {}

  setActiveSql(sql: string | null): void {
    this.activeFilterSql = sql;
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const dir = this.scriptsPath.endsWith(path.sep) ? this.scriptsPath : this.scriptsPath + path.sep;
    if (!document.uri.fsPath.startsWith(dir)) return [];

    const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const docSql = document.getText().trim();
    const isActive = this.activeFilterSql !== null && docSql === this.activeFilterSql.trim();

    if (isActive) {
      return [new vscode.CodeLens(range, {
        title: '✓ Active — click to clear',
        command: 'mEdit.clearFilter',
      })];
    }

    return [new vscode.CodeLens(range, {
      title: '▶ Apply as Filter',
      command: 'mEdit.setFilterFromDocument',
    })];
  }
}
