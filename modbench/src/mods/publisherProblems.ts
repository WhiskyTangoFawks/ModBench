import * as vscode from 'vscode';
import { diagnosticsByPath } from './diagnosticsByPath';
import type { InstanceView, InstanceValue } from '../instanceLoader/instance';

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
    const range = (line: number) => new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER);
    const byFile = diagnosticsByPath(publisherConfiguration.namesNoPath.map(({ file, line, message }) => [
      file, new vscode.Diagnostic(range(line), message, vscode.DiagnosticSeverity.Warning),
    ]));
    for (const [file, list] of byFile) this.collection.set(vscode.Uri.file(file), list);
  }
}
