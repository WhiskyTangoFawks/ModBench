import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PluginAddress, PluginDiagnosisReport } from '../client';
// Type only, so nothing of Mod Management is linked in: the contract for "where this origin's
// files live" belongs beside the rows that answer it.
import type { OriginFolder } from '../instanceLoader/loadOrderSnapshot';

/** Targets the plugin binary itself — these plugins are pre-Track, so there is no source-tree
 *  file to point at, and one scan answers for the whole load order. Warning severity: a
 *  Malformed plugin still loads and plays. */
export function publishLoadDiagnoses(
  collection: vscode.DiagnosticCollection,
  originFolder: OriginFolder,
  reports: PluginDiagnosisReport[],
): void {
  publishOnPluginFiles(collection, originFolder, reports);
}

/** plugins.md, A row: a warning on each plugin file whose bytes differ from what Modbench last
 *  wrote. */
export function publishChangedOutside(
  collection: vscode.DiagnosticCollection,
  originFolder: OriginFolder,
  plugins: readonly PluginAddress[],
): void {
  publishOnPluginFiles(collection, originFolder, plugins.map((p) => ({
    plugin: p.name, origin: p.origin, text: 'Changed outside Modbench: its bytes differ from what Modbench last wrote.',
  })));
}

function publishOnPluginFiles(
  collection: vscode.DiagnosticCollection,
  originFolder: OriginFolder,
  entries: readonly { plugin: string; origin: string; text: string }[],
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of entries) {
    // An origin whose plugins vanished between scan and publish has no file to point at.
    const folder = originFolder(r.origin);
    if (folder === undefined) continue;
    const fsPath = path.join(folder, r.plugin);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}
