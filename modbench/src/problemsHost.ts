import * as vscode from 'vscode';
import type { ProblemsHost } from './ports/fileProblems';

export const problemsHostOver = (collection: vscode.DiagnosticCollection): ProblemsHost<vscode.Diagnostic> => ({
  diagnostic: ({ line, message }) => new vscode.Diagnostic(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER), message, vscode.DiagnosticSeverity.Warning),
  publish: (file, diagnostics) => { collection.set(vscode.Uri.file(file), [...diagnostics]); },
  clearAll: () => { collection.clear(); },
});
