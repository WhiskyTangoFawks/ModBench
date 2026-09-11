import * as vscode from 'vscode';

/** ADR-0019 surfacing: injected so business logic stays free of vscode types. Homed here, next
 *  to the one function that builds it, rather than in any one consumer's own module. */
export type Severity = 'error' | 'warning';
export interface Reporter {
  report(severity: Severity, message: string, detail?: string): void;
}

/** ADR-0019 surfacing: log at the level matching severity, toast for warning and error. */
export function makeReporter(channel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>, tag: string): Reporter {
  return {
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
