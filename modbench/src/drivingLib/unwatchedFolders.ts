import type * as vscode from 'vscode';
import type { Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';

/** A folder is told again only once its watch has recovered and failed anew. */
export function reportUnwatchedFolders(instance: Pick<Instance, 'subscribe'>, reporter: Pick<Reporter, 'report'>): vscode.Disposable {
  let told: ReadonlySet<string> = new Set();
  return instance.subscribe(({ unwatchedFolders }) => {
    const fresh = unwatchedFolders.filter(({ folder }) => !told.has(folder));
    told = new Set(unwatchedFolders.map(({ folder }) => folder));
    if (fresh.length === 0) return;
    reporter.report('warning', 'A change shows only after a refresh in each folder Modbench cannot watch',
      fresh.map(({ folder, reason }) => `"${folder}" (${reason})`).join(', '));
  });
}
