import * as vscode from 'vscode';
import type { CopyAt } from '../instanceLoader/fileConflictIndex';
import type { InstanceValue } from '../instanceLoader/instance';
import { revealArchivedFile } from './archiveFiles';
import { gameFolderFile, gameFolderFileOver } from './modFiles';

// The game loads a later archive's copy over an earlier one's, a game folder archive and a mod's alike.
function archivedCopyOver({ gameFolderArchived: { copies, loadRank } }: Pick<InstanceValue, 'gameFolderArchived'>, path: string, stacked: CopyAt | undefined): CopyAt | undefined {
  const game = copies.get(path.toLowerCase());
  if (game === undefined || stacked?.kind === 'loose') return stacked;
  if (stacked?.kind === 'archived' && (loadRank.get(stacked.archive) ?? -1) > (loadRank.get(game.archive) ?? -1)) return stacked;
  return { kind: 'archived', ...game };
}

/** The copy of `path` that the game gets, or what searching found: a mod's or Overwrite's, else a loose game folder file,
 *  which beats an archived copy, else the archived copy that loads last. A game folder outside the workspace is never a
 *  definition (ADR-0001). */
export function copyTheGameGets(value: Pick<InstanceValue, 'stackedCopies' | 'dataFolderFiles' | 'gameFolderArchived'>, path: string, inWorkspace: (path: string) => boolean): CopyAt | { none: string } {
  const stacked = value.stackedCopies.get(path)?.copies[0]?.at;
  const loose = stacked === undefined ? gameFolderFile(value, path) : gameFolderFileOver(value, path);
  const outside = loose !== undefined && !inWorkspace(loose);
  if (loose !== undefined && !outside) return { kind: 'loose', path: loose };
  const archived = archivedCopyOver(value, path, stacked);
  if (archived !== undefined) return archived;
  if (outside) return { none: `${path} is in the game folder, which is outside the workspace.` };
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
