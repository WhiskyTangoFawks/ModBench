import * as vscode from 'vscode';
import type { Reporter, Severity } from './ports/reporter';

/** ADR-0019 invariant 3 surfacing: log at the level matching severity, toast for warning and
 *  error, each saying what failed and why; a landing toasts at information level and writes
 *  nothing. */
export function makeReporter(channel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>, tag: string): Reporter {
  const log = (severity: Severity, said: string) => {
    const line = `[${tag}] ${severity}: ${said}`;
    if (severity === 'error') channel.error(line); else channel.warn(line);
  };
  const report = (severity: Severity, message: string, detail?: string) => {
    const said = whatAndWhy(message, detail);
    log(severity, said);
    if (severity === 'error') void vscode.window.showErrorMessage(`Modbench: ${said}`);
    else void vscode.window.showWarningMessage(`Modbench: ${said}`);
  };
  return {
    landed: (message) => { void vscode.window.showInformationMessage(`Modbench: ${message}`); },
    report,
    insideDialog: (severity, message, detail) => { log(severity, whatAndWhy(message, detail)); },
    selectionOutcome: (message, outcome, nameOf) => {
      if (outcome.refused.length === 0) return;
      report('error', message, outcome.refused.map((r) => `"${nameOf(r.item)}" (${r.reason})`).join(', '));
    },
  };
}

function whatAndWhy(message: string, detail: string | undefined): string {
  return detail ? `${message} — ${detail}` : message;
}
