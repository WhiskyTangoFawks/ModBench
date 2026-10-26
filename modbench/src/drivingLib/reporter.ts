import * as vscode from 'vscode';
import { reportSelectionOutcome, type ReportAction, type Reporter, type Severity } from '../ports/reporter';

export function makeReporter(channel: Pick<vscode.LogOutputChannel, 'warn' | 'error'>, tag: string): Reporter {
  const log = (severity: Severity, said: string) => {
    const line = `[${tag}] ${said}`;
    if (severity === 'error') channel.error(line); else channel.warn(line);
  };
  const report = (severity: Severity, message: string, detail?: string, action?: ReportAction) => {
    const said = whatAndWhy(message, detail);
    log(severity, said);
    const buttons = action === undefined ? [] : [action.title];
    const shown = severity === 'error' ? vscode.window.showErrorMessage(said, ...buttons) : vscode.window.showWarningMessage(said, ...buttons);
    void Promise.resolve(shown).then((clicked) => { if (clicked !== undefined) action?.run(); });
  };
  return {
    landed: (message) => { void vscode.window.showInformationMessage(message); },
    report,
    shownOnSurface: (severity, message, detail) => { log(severity, whatAndWhy(message, detail)); },
    selectionOutcome: (message, outcome, nameOf, action) => { reportSelectionOutcome(report, message, outcome, nameOf, action); },
  };
}

function whatAndWhy(message: string, detail: string | undefined): string {
  return detail ? `${message} — ${detail}` : message;
}
