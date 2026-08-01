import * as vscode from 'vscode';
import type { Reporter } from './modmanager/deployer';

/** ADR-0026 surfacing reporter: logs at the level matching severity, shows a
 *  toast for warning/error. Pulled out of extension.ts (#198) so its
 *  severity→level dispatch is unit-testable without a real VS Code host —
 *  the only VS Code dependency is the toast call itself, mocked in tests. */
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
