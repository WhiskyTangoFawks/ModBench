import * as vscode from 'vscode';
import { PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';

export const PROBLEMS = {
  name: 'list_problems',
  of: () =>
    vscode.languages.getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file')
      .flatMap(([uri, diagnostics]) => diagnostics.filter(({ source }) => source === PROBLEM_SOURCE).map(({ severity, range, message, code }) => ({
        file: uri.fsPath, severity: vscode.DiagnosticSeverity[severity], line: range.start.line + 1, message,
        ...code === undefined ? {} : { code: typeof code === 'object' ? code.value : code },
      }))),
};
