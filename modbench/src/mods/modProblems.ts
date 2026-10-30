import * as vscode from 'vscode';
import type { InstanceView } from '../instanceLoader/instance';
import type { ModStatuses } from '../modStatus/modStatuses';
import { statusProblems } from '../modStatus/statusProblems';
import { diagnosticsByPath } from './diagnosticsByPath';

/** The Problems panel's view of Mod status: a problem for each unfinished state of a mod, while it holds. */
export class ModProblems {
  private readonly following: vscode.Disposable[];

  constructor(
    private readonly collection: vscode.DiagnosticCollection,
    private readonly instance: Pick<InstanceView, 'value' | 'subscribe'>,
    private readonly statuses: Pick<ModStatuses, 'current' | 'onDidChange'>,
  ) {
    this.following = [instance.subscribe(() => { void this.show(); }), statuses.onDidChange(() => { void this.show(); })];
    void this.show();
  }

  dispose(): void {
    for (const following of this.following) following.dispose();
    this.collection.dispose();
  }

  private async show(): Promise<void> {
    const statuses = await this.statuses.current();
    const folders = new Map((this.instance.value.modFolders ?? []).map((folder) => [folder.modName, folder.path]));
    const range = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
    const problems = [...statuses.values()].flatMap((status) => {
      const folder = folders.get(status.mod);
      return folder === undefined ? [] : statusProblems(status, folder);
    });
    const byFile = diagnosticsByPath(problems.map(({ file, message }) => [file, new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Warning)]));
    this.collection.clear();
    for (const [file, list] of byFile) this.collection.set(vscode.Uri.file(file), list);
  }
}
