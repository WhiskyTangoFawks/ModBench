import * as vscode from 'vscode';

export const PROBLEM_SOURCE = 'Modbench';

export function modbenchDiagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = PROBLEM_SOURCE;
  return diagnostic;
}
