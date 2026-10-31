import { join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import type { FolderFile, FolderValue, HashedPath, PackagesAsked, StatusValues } from '../repositoriesLib/statusValues';
import { ownPathOf } from './excludedPaths';
import type { FileRead, InstallationFile, InstanceAdapter } from './instanceAdapter';

type FolderReads = Pick<InstanceAdapter, 'filesIn' | 'originFileHash' | 'fileStamp' | 'exclusionMark'>;

const otherCase = (path: string): string => path.replace(/\p{L}/gu, (char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()));

/** `folder`'s files, each with its own path and its hash kept in the hash index (ADR-0013). */
export async function folderValueOver(reads: FolderReads, folder: string): Promise<FolderValue> {
  const paths = await reads.filesIn(folder);
  const files = new Map<string, FolderFile>();
  const exclude = new Map<string, string>();
  for (const pathInFolder of paths) {
    const { path, excluded } = ownPathOf(pathInFolder, reads.exclusionMark);
    files.set(pathInFolder, { path, excluded: excluded.length > 0, read: await reads.originFileHash(join(folder, pathInFolder)) });
    for (const one of excluded) exclude.set(one.toLowerCase(), one);
  }
  const holdsCasePair = new Set(paths.map((path) => path.toLowerCase())).size < paths.length;
  const cased = holdsCasePair ? undefined : paths.find((path) => otherCase(path) !== path);
  return { files, exclude: [...exclude.values()], ignoresCase: cased !== undefined && (await reads.fileStamp(join(folder, otherCase(cased)))).kind === 'read' };
}

type ModReads = FolderReads & Pick<InstanceAdapter, 'downloadedFile' | 'gamePlaces' | 'gameFilesTakenBy' | 'submodule'>;

async function gameFilesOver(reads: ModReads, folder: string, paths: readonly string[]): Promise<HashedPath[] | undefined> {
  const places = await reads.gamePlaces();
  if (places.length === 0) return undefined;
  const files: HashedPath[] = [];
  for (const place of places) {
    const taken = await reads.gameFilesTakenBy(place, folder, paths);
    if (taken.kind === 'unreadable') throw new Error(taken.reason);
    files.push(...taken.answer.gameFiles.map(({ pathInFolder, hash }) => ({ path: pathInFolder, hash })));
  }
  return files;
}

/** What a mod's status reads of the instance besides its manifest; a read that rejects leaves the rest unreadable. Nothing
 *  of the folder is read when no manifest is `asked` for. */
export async function modValueOver(reads: ModReads, folder: string, asked: PackagesAsked | undefined): Promise<StatusValues> {
  if (asked === undefined) return { kind: 'notAsked' };
  try {
    const folderValue = await folderValueOver(reads, folder);
    const downloadedFiles = new Map<string, FileRead<InstallationFile | undefined>>();
    for (const name of asked.installationFiles) downloadedFiles.set(name, await reads.downloadedFile(name));
    const gameFiles = asked.gameFiles === undefined ? [] : await gameFilesOver(reads, folder, asked.gameFiles);
    const repositoryHosted = asked.repository !== undefined && !('lacks' in await reads.submodule(asked.repository));
    return { kind: 'read', folder: folderValue, downloadedFiles, gameFiles, repositoryHosted };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}
