import * as vscode from 'vscode';
import type { Reporter } from './modmanager/deployer';

/** ADR-0026 surfacing: log at the level matching severity, toast for warning and error. */
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
