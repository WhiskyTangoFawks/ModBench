import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PluginDiagnosisReport } from './client';
// Type only, so nothing of Mod Management is linked in: the contract for "where this origin's
// files live" belongs beside the rows that answer it.
import type { OriginFolder } from '../instance/loadOrderSnapshot';

/** Targets the plugin binary itself — these plugins are pre-Track, so there is no source-tree
 *  file to point at, and one scan answers for the whole load order. Warning severity: a
 *  Malformed plugin still loads and plays. */
export function publishLoadDiagnoses(
  collection: vscode.DiagnosticCollection,
  originFolder: OriginFolder,
  reports: PluginDiagnosisReport[],
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of reports) {
    // An origin whose copies vanished between scan and publish has no file to point at.
    const folder = originFolder(r.origin);
    if (folder === undefined) continue;
    const fsPath = path.join(folder, r.plugin);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

/** The same reports keyed by plugin filename — one derivation shared by both surfaces, so they
 *  can never disagree. */
export function groupDiagnosesByPlugin(reports: PluginDiagnosisReport[]): Map<string, string[]> {
  const byPlugin = new Map<string, string[]>();
  for (const r of reports) {
    const list = byPlugin.get(r.plugin) ?? [];
    list.push(r.text);
    byPlugin.set(r.plugin, list);
  }
  return byPlugin;
}
