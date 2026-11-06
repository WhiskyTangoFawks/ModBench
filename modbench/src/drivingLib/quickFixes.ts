import * as vscode from 'vscode';
import { PROBLEM_SOURCE } from './modbenchDiagnostic';

export const commandLink = (value: string, command: string, args: readonly unknown[]): { value: string; target: vscode.Uri } => ({
  value,
  target: vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify(args))}`),
});

const titleOf = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

function fixOf(diagnostic: unknown): vscode.CodeAction | undefined {
  if (!(diagnostic instanceof vscode.Diagnostic)) return undefined;
  const { code } = diagnostic;
  if (diagnostic.source !== PROBLEM_SOURCE || typeof code !== 'object' || code.target.scheme !== 'command') return undefined;
  const title = titleOf(String(code.value));
  const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  fix.diagnostics = [diagnostic];
  const args: unknown = JSON.parse(code.target.query);
  fix.command = { command: code.target.path, title, arguments: Array.isArray(args) ? args : [] };
  return fix;
}

/** common.md, Reporting: a problem that a gesture clears offers that gesture as its quick fix. */
export const quickFixes = {
  provideCodeActions(_document: unknown, _range: unknown, { diagnostics }: { readonly diagnostics: readonly unknown[] }): vscode.CodeAction[] {
    return diagnostics.flatMap((diagnostic) => fixOf(diagnostic) ?? []);
  },
} satisfies vscode.CodeActionProvider;
