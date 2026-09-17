import * as vscode from 'vscode';
import type { Reporter } from './ports/reporter';

/** ADR-0019 invariant 3 surfacing: log at the level matching severity, toast for warning and
 *  error; a landing toasts at information level and writes nothing. */
export function makeReporter(channel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>, tag: string): Reporter {
  return {
    landed: (message) => { void vscode.window.showInformationMessage(`Modbench: ${message}`); },
    report: (severity, message, detail) => {
      const suffix = detail ? ` — ${detail}` : '';
      const line = `[${tag}] ${severity}: ${message}${suffix}`;
      if (severity === 'error') {
        channel.error(line);
        void vscode.window.showErrorMessage(`Modbench: ${message}`);
      } else {
        channel.warn(line);
        void vscode.window.showWarningMessage(`Modbench: ${message}`);
      }
    },
  };
}
