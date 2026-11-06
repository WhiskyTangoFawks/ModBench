import * as vscode from 'vscode';
import { modArgumentOf } from '../drivingLib/argument';
import { goToRowOrFile } from '../drivingLib/goToRow';
import type { Reporter } from '../ports/reporter';
import type { ModlistNode, ModNode } from './ModListProvider';

const onlyModRow = (selection: readonly ModlistNode[]): ModNode | undefined => {
  const [only, ...rest] = selection;
  return rest.length === 0 && only?.kind === 'mod' ? only : undefined;
};

const modOf = (clicked: unknown, viewSelection: () => readonly ModlistNode[]): string | undefined =>
  modArgumentOf(clicked ?? onlyModRow(viewSelection()))?.name;

interface GoToModRowDeps {
  rowOf: (mod: string) => ModlistNode | undefined;
  folderOf: (mod: string) => string | undefined;
  reveal: (row: ModlistNode) => PromiseLike<void>;
  reporter: Pick<Reporter, 'report'>;
}

/** `go to` on a mod: Go to Definition and the palette are its entry points (commands.md). */
export function registerGoToModRowCommand(
  { rowOf, folderOf, reveal, reporter }: GoToModRowDeps, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.goTo', async (clicked?: unknown) => {
    const mod = modOf(clicked, viewSelection);
    if (mod === undefined) return;
    await goToRowOrFile({
      name: `"${mod}"`, row: rowOf(mod), file: folderOf(mod), reveal, reporter, nowhere: 'Mods shows no row for it and no folder holds it.',
    });
  });
}

/** `referenced by` on a mod row: `referencedBy` lists where files name it (mods.md, Menus and keys). */
export function registerModReferencedByCommand(
  referencedBy: (mod: string) => Promise<void>, viewSelection: () => readonly ModlistNode[],
): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.referencedBy', async (clicked?: unknown) => {
    const mod = modOf(clicked, viewSelection);
    if (mod !== undefined) await referencedBy(mod);
  });
}
