// mods.md, Pickers, Go to mod: select the row of the mod or Overwrite a copy of a file names.

import * as vscode from 'vscode';
import { goToModCandidates, originLabel, sameOrigin } from '../instanceLoader/fileConflictIndex';
import type { FileOrigin, Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { registerModsGesture, singularArgument } from './gestureEntry';
import type { ModlistNode, ModNode, OverwriteNode } from './ModListProvider';
import { reportFailure } from '../drivingLib/reportFailure';

export interface GoToModView {
  selection: () => readonly ModlistNode[];
  rowFor: (origin: FileOrigin) => ModNode | OverwriteNode | undefined;
  reveal: (row: ModNode | OverwriteNode) => Thenable<void>;
}

function originOf(value: unknown): FileOrigin | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'runtimeOutput') return { kind: 'runtimeOutput' };
  return value.kind === 'mod' && 'name' in value && typeof value.name === 'string' ? { kind: 'mod', name: value.name } : undefined;
}

async function pickFrom(candidates: readonly FileOrigin[]): Promise<FileOrigin | undefined> {
  if (candidates.length < 2) return candidates[0];
  const items = [...candidates].reverse().map((origin) => ({ label: originLabel(origin), origin }));
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Go to mod…' }))?.origin;
}

export function registerGoToModCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, view: GoToModView,
): vscode.Disposable {
  return registerModsGesture('modbench.mod.goToMod', view.selection, async (entry, option) => {
    const row = singularArgument(entry, 'file');
    if (row === undefined) return;
    const candidates = goToModCandidates(instance.value.files.get(row.file.relativePath), row.origin);
    const given = originOf(option);
    if (option !== undefined && !candidates.some((candidate) => given !== undefined && sameOrigin(candidate, given))) {
      reporter.report('error', 'Failed to go to a mod.', `"${row.file.relativePath}" has no other copy in that mod.`);
      return;
    }
    const target = given ?? await pickFrom(candidates);
    if (target === undefined) return;
    await reportFailure(reporter, `Failed to go to "${originLabel(target)}".`, async () => {
      const targetRow = view.rowFor(target);
      if (targetRow === undefined) throw new Error('No row shows it.');
      await view.reveal(targetRow);
    });
  });
}
