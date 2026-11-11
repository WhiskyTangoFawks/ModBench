import * as vscode from 'vscode';
import { modArgumentOf } from '../drivingLib/argument';
import { goToRowOrFile } from '../drivingLib/goToRow';
import type { InstanceValue } from '../instanceLoader/instance';
import type { Reporter } from '../ports/reporter';
import { samePath } from '../symbolNames/symbolNames';
import type { ModlistNode, ModNode } from './ModListProvider';
import { ArchivedFileNode, FileNode } from './modFiles';
import { hasFsPath } from './archiveFiles';

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

type FilesHeld = Pick<InstanceValue, 'filesByMod' | 'dataFolderFiles'>;

interface ReferencedByDeps {
  /** Lists each place a file names the mod. */
  mod: (mod: string) => Promise<void>;
  /** Lists each record that names the file at its path in the Data folder. */
  file: (path: string) => Promise<void>;
  value: () => FilesHeld;
  reporter: Pick<Reporter, 'report'>;
}

// A file the Explorer shows, by its path in the Data folder: in a mod, or in the game's Data folder.
function dataPathOf({ filesByMod, dataFolderFiles }: FilesHeld, file: string): string | undefined {
  const inData = dataFolderFiles.kind === 'listed' ? [...dataFolderFiles.files.values()] : [];
  return [...[...filesByMod.values()].flat(), ...inData].find(({ path }) => samePath(path, file))?.relativePath;
}

/** `referenced by` on a mod row, a file row, or a file in the Explorer (mods.md, Menus and keys). */
export function registerModReferencedByCommand(deps: ReferencedByDeps, viewSelection: () => readonly ModlistNode[]): vscode.Disposable {
  return vscode.commands.registerCommand('modbench.mod.referencedBy', async (clicked?: unknown) => {
    if (clicked instanceof FileNode) return deps.file(clicked.file.relativePath);
    if (clicked instanceof ArchivedFileNode) return deps.file(clicked.path);
    if (hasFsPath(clicked)) {
      const path = dataPathOf(deps.value(), clicked.fsPath);
      if (path !== undefined) return deps.file(path);
      deps.reporter.report('error', `Could not list where files name ${clicked.fsPath}.`, 'No mod holds it, and it is not in the game\'s Data folder.');
      return;
    }
    const mod = modOf(clicked, viewSelection);
    if (mod !== undefined) await deps.mod(mod);
  });
}
