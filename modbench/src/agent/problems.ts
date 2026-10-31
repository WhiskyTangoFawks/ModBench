import * as vscode from 'vscode';
import { PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';

export const PROBLEMS = {
  name: 'list_problems',
  description: 'The problems the Problems panel shows from Modbench, on any file, open or not: its file, severity, line, message and code. A code naming a gesture, such as decompile and repair, is the gesture that fixes the problem.',
  of: () =>
    vscode.languages.getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file')
      .flatMap(([uri, diagnostics]) => diagnostics.filter(({ source }) => source === PROBLEM_SOURCE).map(({ severity, range, message, code }) => ({
        file: uri.fsPath, severity: vscode.DiagnosticSeverity[severity], line: range.start.line + 1, message,
        ...code === undefined ? {} : { code: typeof code === 'object' ? code.value : code },
      }))),
};
