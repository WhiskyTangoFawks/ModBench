import * as vscode from 'vscode';
import { foldPath, type CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { revealArchivedFile } from './archiveFiles';

/** The copy of the file at `path` in the Data folder that the game gets: a mod's or Overwrite's, else the game folder's own.
 *  A loose file in the game folder wins over an archived copy of a mod, as `gameFolderFileOver` has it. */
export function copyTheGameGets(value: Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles'>, path: string): CopyAt | undefined {
  const stacked = value.stackedCopies.get(path)?.copies[0]?.at;
  const inGameFolder = value.dataFolderFiles.kind === 'listed' ? value.dataFolderFiles.files.get(foldPath(path))?.path : undefined;
  if (stacked?.kind === 'loose' || inGameFolder === undefined) return stacked;
  return { kind: 'loose', path: inGameFolder };
}

export async function revealCopy(copy: CopyAt): Promise<void> {
  if (copy.kind === 'archived') await revealArchivedFile(copy);
  else await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(copy.path));
}
