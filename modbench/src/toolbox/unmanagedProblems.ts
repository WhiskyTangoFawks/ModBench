import * as vscode from 'vscode';
import { overwritePathOf } from '../deployment/deployment';

export const MOVE_TO_OVERWRITE = 'modbench.instance.moveToOverwrite';

interface LeftOut {
  readonly path: string;
  readonly winner: string;
}

// A diagnostic's `code` target is how the Problems panel carries a link, as plugins/loadDiagnostics.ts does; a quick fix needs a provider registered for the same click.
const moveToOverwriteLink = (path: string): vscode.Diagnostic['code'] =>
  overwritePathOf(path) === undefined
    ? undefined
    : { value: 'move to Overwrite', target: vscode.Uri.parse(`command:${MOVE_TO_OVERWRITE}?${encodeURIComponent(JSON.stringify([[path]]))}`) };

/** deployment-hardlink.md, Files deploy does not manage, stories 2 to 4: replaces the problems with one on each file in `unmanaged`, by path below the deployment folder. */
export function publishUnmanagedProblems(collection: vscode.DiagnosticCollection, unmanaged: readonly { path: string; file: string }[], leftOut: readonly LeftOut[]): void {
  collection.clear();
  for (const { path, file } of unmanaged) {
    const winner = leftOut.find((left) => left.path === path)?.winner;
    const message = winner === undefined
      ? 'Deploy does not manage this file.'
      : `Deploy does not manage this file, and left out ${winner}, which the game would get at its path.`;
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Warning);
    diagnostic.code = moveToOverwriteLink(path);
    collection.set(vscode.Uri.file(file), [diagnostic]);
  }
}
