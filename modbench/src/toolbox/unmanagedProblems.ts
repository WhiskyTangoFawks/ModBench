import * as vscode from 'vscode';
import { overwritePathOf } from '../deployment/deployment';
import { modbenchDiagnostic, PROBLEM_SOURCE } from '../drivingLib/modbenchDiagnostic';

export const MOVE_TO_OVERWRITE = 'modbench.instance.moveToOverwrite';

interface LeftOut {
  readonly path: string;
  readonly winner: string;
}

interface Unmanaged {
  readonly path: string;
  readonly file: string;
}

/** deployment-hardlink.md, Files deploy does not manage, stories 2 to 4: one Problems panel warning on each file the
 *  deployment folder holds that deploy does not manage, each with move to Overwrite as its quick fix. */
export function unmanagedProblems(collection: vscode.DiagnosticCollection) {
  let pathOf = new Map<string, string>();
  return {
    /** Replaces the problems with one on each file in `unmanaged`. */
    publish(unmanaged: readonly Unmanaged[], leftOut: readonly LeftOut[]): void {
      collection.clear();
      pathOf = new Map(unmanaged.map(({ path, file }) => [file, path]));
      for (const { path, file } of unmanaged) {
        const winner = leftOut.find((left) => left.path === path)?.winner;
        const message = winner === undefined
          ? 'Deploy does not manage this file.'
          : `Deploy does not manage this file, and left out ${winner}, which the game would get at its path.`;
        const diagnostic = modbenchDiagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Warning);
        collection.set(vscode.Uri.file(file), [diagnostic]);
      }
    },
    quickFixes: {
      provideCodeActions(document: { readonly uri: { readonly fsPath: string } }, _range: unknown, { diagnostics }: { readonly diagnostics: readonly { readonly source?: string }[] }): vscode.CodeAction[] {
        const path = pathOf.get(document.uri.fsPath);
        const ours = diagnostics.filter(({ source }) => source === PROBLEM_SOURCE);
        if (path === undefined || overwritePathOf(path) === undefined || ours.length === 0) return [];
        const fix = new vscode.CodeAction('Move to Overwrite', vscode.CodeActionKind.QuickFix);
        fix.diagnostics = ours.filter((diagnostic): diagnostic is vscode.Diagnostic => diagnostic instanceof vscode.Diagnostic);
        fix.command = { command: MOVE_TO_OVERWRITE, title: 'Move to Overwrite', arguments: [[path]] };
        return [fix];
      },
    } satisfies vscode.CodeActionProvider,
  };
}
