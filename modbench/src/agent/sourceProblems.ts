import * as vscode from 'vscode';
import { isPluginSourcePath } from '../instanceAdapter/instanceAdapter';

export const SOURCE_PROBLEMS = {
  name: 'list_source_problems',
  description: 'The problems the Problems panel shows on every plugin source file, open or not: its file, severity, line and message.',
  of: () =>
    vscode.languages.getDiagnostics()
      .filter(([uri]) => uri.scheme === 'file' && isPluginSourcePath(uri.fsPath))
      .flatMap(([uri, diagnostics]) => diagnostics.map(({ severity, range, message }) => ({
        file: uri.fsPath, severity: vscode.DiagnosticSeverity[severity], line: range.start.line + 1, message,
      }))),
};
