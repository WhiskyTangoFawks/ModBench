import type * as vscode from 'vscode';

export function diagnosticsByPath(entries: Iterable<readonly [string, vscode.Diagnostic]>): Map<string, vscode.Diagnostic[]> {
  const byPath = new Map<string, vscode.Diagnostic[]>();
  for (const [path, diagnostic] of entries) byPath.set(path, [...byPath.get(path) ?? [], diagnostic]);
  return byPath;
}
