import * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { revealArchivedFile } from './archiveFiles';
import { gameFolderFile, gameFolderFileOver } from './modFiles';

/** The copy of the file at `path` that the game gets, or what searching for it found: an enabled mod or Overwrite, else a
 *  loose file in the game folder, which beats an archived copy. The game folder's own archives are not read. */
export function copyTheGameGets(value: Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles'>, path: string): CopyAt | { none: string } {
  const stacked = value.stackedCopies.get(path)?.copies[0]?.at;
  const loose = stacked === undefined ? gameFolderFile(value, path) : gameFolderFileOver(value, path);
  if (loose !== undefined) return { kind: 'loose', path: loose };
  if (stacked !== undefined) return stacked;
  return {
    none: value.dataFolderFiles.kind === 'listed'
      ? `No enabled mod, Overwrite or loose file in the Data folder holds ${path}.`
      : `No enabled mod or Overwrite holds ${path}, and the Data folder's files could not be listed.`,
  };
}

export async function revealCopy(copy: CopyAt): Promise<void> {
  if (copy.kind === 'archived') await revealArchivedFile(copy);
  else await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(copy.path));
}
