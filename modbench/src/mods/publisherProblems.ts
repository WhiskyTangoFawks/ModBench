import * as vscode from 'vscode';
import { diagnosticsByPath } from './diagnosticsByPath';
import type { InstanceView, InstanceValue, TagPathProblem } from '../instanceLoader/instance';

const wording = (problem: TagPathProblem): string => {
  const entry = `${problem.tag.name}: "${problem.entry}"`;
  return problem.kind === 'namesNoPath' ? `${entry} names no path in the instance.` : `${entry} could not be checked: ${problem.reason}`;
};

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
    const byFile = diagnosticsByPath(publisherConfiguration.pathProblems.map((problem) => [
      problem.file, new vscode.Diagnostic(range(problem.line), wording(problem), vscode.DiagnosticSeverity.Warning),
    ]));
    for (const [file, list] of byFile) this.collection.set(vscode.Uri.file(file), list);
  }
}
