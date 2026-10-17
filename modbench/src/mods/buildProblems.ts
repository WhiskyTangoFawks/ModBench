import * as vscode from 'vscode';
import type { CompileDiagnostic, PluginAddress } from '../client';
import type { SourceFiles } from '../instanceLoader/loadOrderSnapshot';
import { pluginAddressKey } from '../wire/pluginAddress';

/** The build's diagnostics in the Problems panel. A build replaces those of each plugin it compiled
 *  and no other plugin's, so one refused beside it in its mod keeps what its last build found. */
export class BuildProblems {
  private readonly published = new Map<string, vscode.Uri[]>();

  constructor(private readonly collection: vscode.DiagnosticCollection) {}

  dispose(): void {
    this.collection.dispose();
  }

  publish(plugin: PluginAddress, files: SourceFiles | undefined, diagnostics: readonly CompileDiagnostic[]): void {
    const key = pluginAddressKey(plugin);
    for (const uri of this.published.get(key) ?? []) this.collection.delete(uri);
    if (files === undefined) {
      this.published.delete(key);
      return;
    }

    const byPath = new Map<string, vscode.Diagnostic[]>();
    for (const d of diagnostics) {
      const fsPath = files.file(d.sourceRelativePath);
      const list = byPath.get(fsPath) ?? [];
      list.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning));
      byPath.set(fsPath, list);
    }
    const uris = [...byPath].map(([fsPath, list]) => {
      const uri = vscode.Uri.file(fsPath);
      this.collection.set(uri, list);
      return uri;
    });
    this.published.set(key, uris);
  }
}
