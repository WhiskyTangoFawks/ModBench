import * as vscode from 'vscode';
import type { FileProblem, FileProblems } from '../ports/fileProblems';

const rangeOf = ({ line }: FileProblem): vscode.Range =>
  (line === undefined ? new vscode.Range(0, 0, 0, 0) : new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER));

/** A file's problems in the Problems panel. */
export class FileProblemDiagnostics implements FileProblems, vscode.Disposable {
  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  set(file: string, problems: readonly FileProblem[]): void {
    const uri = vscode.Uri.file(file);
    if (problems.length === 0) this.collection.delete(uri);
    else this.collection.set(uri, problems.map((problem) => new vscode.Diagnostic(rangeOf(problem), problem.message, vscode.DiagnosticSeverity.Warning)));
  }

  clearAll(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}
