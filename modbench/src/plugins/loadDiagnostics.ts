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
  codeOf?: (plugin: PluginAddress) => vscode.Diagnostic['code'],
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of entries) {
    const plugin = { name: r.plugin, origin: r.origin };
    // A plugin that vanished between scan and publish has no file to point at.
    const fsPath = pluginFile(plugin);
    if (fsPath === undefined) continue;
    const list = byUri.get(fsPath) ?? [];
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, severity);
    if (codeOf !== undefined) diagnostic.code = codeOf(plugin);
    list.push(diagnostic);
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

/** plugin-source.md, Decompile and repair, story 1: a Malformed entry's link in the Problems panel, which fires the
 *  gesture on its plugin. */
export const decompileAndRepairLink = (plugin: PluginAddress): vscode.Diagnostic['code'] => ({
  value: 'decompile and repair',
  target: vscode.Uri.parse(`command:modbench.plugin.decompileAndRepair?${encodeURIComponent(JSON.stringify([plugin]))}`),
});
