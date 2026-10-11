import * as vscode from 'vscode';
import type { PluginAddress } from '../client';
import type { PluginProblem } from './pluginFacts';

type PluginFile = (plugin: PluginAddress) => string | undefined;

/** Targets the plugin binary itself, which is where a malformed plugin's diagnoses and a change
 *  outside Modbench both live, and one call answers for the whole load order. Warning severity:
 *  such a plugin still loads and plays. */
export function publishPluginWarnings(collection: vscode.DiagnosticCollection, pluginFile: PluginFile, entries: readonly PluginProblem[]): void {
  publish(collection, pluginFile, entries, vscode.DiagnosticSeverity.Warning);
}

/** As {@link publishPluginWarnings}, for a plugin that failed to read. */
export function publishPluginErrors(collection: vscode.DiagnosticCollection, pluginFile: PluginFile, entries: readonly PluginProblem[]): void {
  publish(collection, pluginFile, entries, vscode.DiagnosticSeverity.Error);
}

function publish(
  collection: vscode.DiagnosticCollection, pluginFile: PluginFile, entries: readonly PluginProblem[], severity: vscode.DiagnosticSeverity,
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
