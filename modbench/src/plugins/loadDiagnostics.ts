import * as vscode from 'vscode';
import type { PluginDiagnosisReport } from '../client';
import type { OriginFilesOf } from '../instanceLoader/loadOrderSnapshot';

/** Targets the plugin binary itself, which is where a malformed plugin's diagnoses and a change
 *  outside Modbench both live, and one call answers for the whole load order. Warning severity:
 *  such a plugin still loads and plays. */
export function publishPluginWarnings(
  collection: vscode.DiagnosticCollection,
  originFiles: OriginFilesOf,
  entries: readonly Pick<PluginDiagnosisReport, 'plugin' | 'origin' | 'text'>[],
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of entries) {
    // An origin whose plugins vanished between scan and publish has no file to point at.
    const fsPath = originFiles(r.origin)?.file(r.plugin);
    if (fsPath === undefined) continue;
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}
