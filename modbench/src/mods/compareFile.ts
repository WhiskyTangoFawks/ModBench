import * as vscode from 'vscode';
import { foldPath, originLabel, sameOrigin } from '../instanceLoader/fileConflictIndex';
import type { FileOrigin, Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { reportFailure } from '../drivingLib/reportFailure';
import { copyOfConflictCell } from '../wire/conflictTable';
import { gestureEntry, singularArgument } from '../drivingLib/gestureEntry';
import type { ModlistNode } from './ModListProvider';

function copyOf(
  clicked: unknown, selected: readonly ModlistNode[] | undefined, viewSelection: () => readonly ModlistNode[],
): { origin: Extract<FileOrigin, { kind: 'mod' }>; path: string } | undefined {
  const cell = copyOfConflictCell(clicked);
  const row = singularArgument(gestureEntry(clicked, selected, viewSelection), 'file');
  const taken = cell ?? (row === undefined ? undefined : { origin: row.origin, path: row.file.relativePath });
  return taken?.origin.kind === 'mod' ? { origin: taken.origin, path: taken.path } : undefined;
}

export function registerCompareFileCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.compareFile', async (clicked?: unknown, selected?: readonly ModlistNode[]) => {
    const copy = copyOf(clicked, selected, viewSelection);
    if (copy === undefined) return;
    const { value } = instance;
    const winning = value.files.get(copy.path);
    const own = value.filesByMod.get(copy.origin.name)?.find((listed) => foldPath(listed.relativePath) === foldPath(copy.path));
    const label = copy.origin.name;
    const message = `Failed to compare "${copy.path}".`;
    if (own === undefined) {
      reporter.report('error', message, `"${label}" has no copy of it.`);
      return;
    }
    if (winning === undefined || sameOrigin(winning.winnerOrigin, copy.origin)) {
      reporter.report('error', message, `"${label}" holds the winning copy.`);
      return;
    }
    const title = `${copy.path}: ${label} ↔ ${originLabel(winning.winnerOrigin)}`;
    await reportFailure(reporter, message, async () => {
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(own.sourcePath), vscode.Uri.file(winning.winner), title);
    });
  });
}
