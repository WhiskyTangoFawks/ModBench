import * as vscode from 'vscode';
import * as path from 'node:path';
import type { PluginDiagnosisReport } from './ApiClient';

/** #570: publishes the session-load Kind B scan's diagnoses to the Problems panel — a sibling of
 *  `editorCommands.ts`'s publishCompileDiagnostics, but targeting the plugin binary itself
 *  (`mods/<origin>/<plugin>`): these plugins are pre-Track, so there is no source-tree file to
 *  point at. Replaced wholesale each scan (never per mod): one scan answers for the whole load
 *  order. Each entry's message is `PluginDiagnosisReport.text` — the Track refusal's own wording
 *  (#569), one vocabulary. Warning severity: a Malformed plugin still loads and plays. */
export function publishLoadDiagnoses(
  collection: vscode.DiagnosticCollection, instanceRoot: string, reports: PluginDiagnosisReport[],
): void {
  collection.clear();
  const byUri = new Map<string, vscode.Diagnostic[]>();
  for (const r of reports) {
    const fsPath = path.join(instanceRoot, 'mods', r.origin, r.plugin);
    const list = byUri.get(fsPath) ?? [];
    list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), r.text, vscode.DiagnosticSeverity.Warning));
    byUri.set(fsPath, list);
  }
  for (const [fsPath, list] of byUri) collection.set(vscode.Uri.file(fsPath), list);
}

/** #570: the same reports keyed by plugin filename, for `PluginsTreeComposite.setDiagnoses`'s
 *  row decoration — one derivation shared by both surfaces so they can never disagree. */
export function groupDiagnosesByPlugin(reports: PluginDiagnosisReport[]): Map<string, string[]> {
  const byPlugin = new Map<string, string[]>();
  for (const r of reports) {
    const list = byPlugin.get(r.plugin) ?? [];
    list.push(r.text);
    byPlugin.set(r.plugin, list);
  }
  return byPlugin;
}
