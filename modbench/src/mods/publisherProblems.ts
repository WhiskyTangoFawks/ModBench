import * as vscode from 'vscode';
import type { InstanceView, InstanceValue } from '../instanceLoader/instance';

/** The publisher tags that name no path in the instance, in the Problems panel, each on its line in the publisher's configuration. */
export class PublisherProblems {
  private readonly following: vscode.Disposable;

  constructor(private readonly collection: vscode.DiagnosticCollection, instance: Pick<InstanceView, 'value' | 'subscribe'>) {
    this.show(instance.value);
    this.following = instance.subscribe((value) => { this.show(value); });
  }

  dispose(): void {
    this.following.dispose();
    this.collection.dispose();
  }

  private show({ publisherConfiguration }: InstanceValue): void {
    this.collection.clear();
    if (publisherConfiguration.kind !== 'read') return;
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const { file, line, tag, entry } of publisherConfiguration.namesNoPath) {
      const list = byFile.get(file) ?? [];
      const range = new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER);
      list.push(new vscode.Diagnostic(range, `${tag.name}: "${entry}" names no path in the instance.`, vscode.DiagnosticSeverity.Warning));
      byFile.set(file, list);
    }
    for (const [file, list] of byFile) this.collection.set(vscode.Uri.file(file), list);
  }
}
