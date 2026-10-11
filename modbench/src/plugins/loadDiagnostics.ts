import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import type { PluginProblem } from './pluginFacts';

/** Targets the plugin binary itself, which is where a malformed plugin's diagnoses, a change
 *  outside Modbench and a failed read's diagnosis all live, and one call answers for the whole
 *  load order. */
export function publishPluginProblems(
  collection: vscode.DiagnosticCollection,
  pluginFile: (plugin: PluginAddress) => string | undefined,
  entries: readonly PluginProblem[],
  severity: vscode.DiagnosticSeverity,
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of entries) {
    // A plugin that vanished between scan and publish has no file to point at.
    const fsPath = pluginFile({ name: r.plugin, origin: r.origin });
    if (fsPath === undefined) continue;
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, severity));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}
