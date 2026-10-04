// mods.md, Pickers, Go to mod: select the row of the mod or Overwrite a copy of a file names.

import * as vscode from 'vscode';
import type { FileOrigin, Instance } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { registerModsGesture, singularArgument } from './gestureEntry';
import { goToModCandidates, sameOrigin } from './modFiles';
import type { ModlistNode, ModNode, OverwriteNode } from './ModListProvider';
import { reportFailure } from './modManagementCommands';

export interface GoToModView {
  selection: () => readonly ModlistNode[];
  rowFor: (origin: FileOrigin) => ModNode | OverwriteNode | undefined;
  reveal: (row: ModNode | OverwriteNode) => Thenable<void>;
}

const nameOf = (origin: FileOrigin): string => (origin.kind === 'mod' ? origin.name : 'Overwrite');

function originOf(value: unknown): FileOrigin | undefined {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined;
  if (value.kind === 'runtimeOutput') return { kind: 'runtimeOutput' };
  return value.kind === 'mod' && 'name' in value && typeof value.name === 'string' ? { kind: 'mod', name: value.name } : undefined;
}

async function targetOf(candidates: readonly FileOrigin[], option: unknown): Promise<FileOrigin | undefined> {
  const given = originOf(option);
  if (given !== undefined && candidates.some((candidate) => sameOrigin(candidate, given))) return given;
  if (candidates.length < 2) return candidates[0];
  const items = [...candidates].reverse().map((origin) => ({ label: nameOf(origin), origin }));
  return (await vscode.window.showQuickPick(items, { placeHolder: 'Go to mod…' }))?.origin;
}

export function registerGoToModCommand(
  instance: Pick<Instance, 'value'>, reporter: Reporter, view: GoToModView,
): vscode.Disposable {
  return registerModsGesture('modbench.mod.goToMod', view.selection, async (entry, option) => {
    const row = singularArgument(entry, 'file');
    if (row === undefined) return;
    const target = await targetOf(goToModCandidates(instance.value.files.get(row.file.relativePath), row.origin), option);
    if (target === undefined) return;
    await reportFailure(reporter, `Failed to go to "${nameOf(target)}".`, async () => {
      const targetRow = view.rowFor(target);
      if (targetRow === undefined) throw new Error('No row shows it.');
      await view.reveal(targetRow);
    });
  });
}
