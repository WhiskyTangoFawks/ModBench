import * as vscode from 'vscode';
import type { ProblemsHost } from './ports/fileProblems';
import { modbenchDiagnostic } from './drivingLib/modbenchDiagnostic';

export const problemsHostOver = (collection: vscode.DiagnosticCollection): ProblemsHost<vscode.Diagnostic> => ({
  diagnostic: ({ line, message }) => modbenchDiagnostic(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER), message, vscode.DiagnosticSeverity.Warning),
  publish: (file, diagnostics) => { collection.set(vscode.Uri.file(file), [...diagnostics]); },
  clearAll: () => { collection.clear(); },
});
