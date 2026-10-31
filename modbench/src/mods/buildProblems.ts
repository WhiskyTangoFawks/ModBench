import * as vscode from 'vscode';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { diagnosticsByPath } from './diagnosticsByPath';
import type { CompileDiagnostic, PluginAddress } from '../client';
import type { SourceFiles } from '../instanceLoader/loadOrderSnapshot';
import type { InstanceView } from '../instanceLoader/instance';
import { sourceFiles } from '../instanceLoader/loadOrderSnapshot';
import { pluginAddressKey } from '../wire/pluginAddress';

/** The build's diagnostics in the Problems panel. A build replaces those of each plugin it compiled and no other
 *  plugin's. A mod the instance holds no source folder for keeps none. */
export class BuildProblems {
  private readonly published = new Map<string, { readonly origin: string; readonly uris: vscode.Uri[] }>();
  private readonly subscription: { dispose(): void };

  constructor(private readonly collection: vscode.DiagnosticCollection, instance: Pick<InstanceView, 'subscribe'>) {
    this.subscription = instance.subscribe((value) => {
      for (const [key, { origin, uris }] of this.published) {
        if (sourceFiles(value, origin) !== undefined) continue;
        for (const uri of uris) this.collection.delete(uri);
        this.published.delete(key);
      }
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.collection.dispose();
  }

  publish(plugin: PluginAddress, files: SourceFiles | undefined, diagnostics: readonly CompileDiagnostic[]): void {
    const key = pluginAddressKey(plugin);
    for (const uri of this.published.get(key)?.uris ?? []) this.collection.delete(uri);
    if (files === undefined) {
      this.published.delete(key);
      return;
    }

    const byPath = diagnosticsByPath(diagnostics.map((d) => [
      files.file(d.sourceRelativePath), modbenchDiagnostic(new vscode.Range(0, 0, 0, 0), d.message, vscode.DiagnosticSeverity.Warning),
    ]));
    const uris = [...byPath].map(([fsPath, list]) => {
      const uri = vscode.Uri.file(fsPath);
      this.collection.set(uri, list);
      return uri;
    });
    this.published.set(key, { origin: plugin.origin, uris });
  }
}
