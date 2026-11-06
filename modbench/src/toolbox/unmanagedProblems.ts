import * as vscode from 'vscode';
import { overwritePathOf } from '../deployment/deployment';
import { modbenchDiagnostic } from '../drivingLib/modbenchDiagnostic';
import { commandLink } from '../drivingLib/quickFixes';

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
 *  deployment folder holds that deploy does not manage, each with a link to move to Overwrite, which `quickFixes` offers. */
export function unmanagedProblems(collection: vscode.DiagnosticCollection) {
  return {
    /** Replaces the problems with one on each file in `unmanaged`. */
    publish(unmanaged: readonly Unmanaged[], leftOut: readonly LeftOut[]): void {
      collection.clear();
      for (const { path, file } of unmanaged) {
        const winner = leftOut.find((left) => left.path === path)?.winner;
        const message = winner === undefined
          ? 'Deploy does not manage this file.'
          : `Deploy does not manage this file, and left out ${winner}, which the game would get at its path.`;
        const diagnostic = modbenchDiagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Warning);
        if (overwritePathOf(path) !== undefined) diagnostic.code = commandLink('move to Overwrite', MOVE_TO_OVERWRITE, [[path]]);
        collection.set(vscode.Uri.file(file), [diagnostic]);
      }
    },
  };
}
