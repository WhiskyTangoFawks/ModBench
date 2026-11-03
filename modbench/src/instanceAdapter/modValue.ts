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
  const exclude = new Set<string>();
  for (const pathInFolder of paths) {
    const { path, excluded } = ownPathOf(pathInFolder, reads.exclusionMark);
    files.set(pathInFolder, { path, excluded: excluded.length > 0, read: await reads.originFileHash(join(folder, pathInFolder)) });
    for (const one of excluded) exclude.add(one);
  }
  const holdsCasePair = new Set(paths.map((path) => path.toLowerCase())).size < paths.length;
  const cased = holdsCasePair ? undefined : paths.find((path) => otherCase(path) !== path);
  return { files, exclude: [...exclude], ignoresCase: cased !== undefined && (await reads.fileStamp(join(folder, otherCase(cased)))).kind === 'read' };
}

const isGitsOwn = (path: string): boolean => path === '.git' || path.startsWith('.git/');

/** A folder's files that git does not hold, by their own paths: its manifest names those and no others
 *  (instance-repository.md, The manifest, story 5). */
export async function unheldFolderValueOver(reads: FolderReads, heldByGit: readonly string[], folder: string): Promise<FolderValue> {
  const held = new Set(heldByGit);
  const filesIn = async (at: string): Promise<readonly string[]> => (await reads.filesIn(at)).filter((path) => !isGitsOwn(path) && !held.has(path));
  return folderValueOver({ ...reads, filesIn }, folder);
}

type ModReads = FolderReads & Pick<InstanceAdapter, 'downloadedFile' | 'gamePlaces' | 'gameFilesTakenBy' | 'submodule' | 'sourceFolderTracked' | 'flaggedHash'>;

// None when the game folder is not found.
async function gameFilesOver(reads: ModReads, folder: string, paths: readonly string[]): Promise<FileRead<HashedPath[] | undefined>> {
  const places = await reads.gamePlaces();
  if (places.length === 0) return { kind: 'read', answer: undefined };
  const files: HashedPath[] = [];
  for (const place of places) {
    const taken = await reads.gameFilesTakenBy(place, folder, paths);
    if (taken.kind === 'unreadable') return taken;
    files.push(...taken.answer.gameFiles.map(({ pathInFolder, hash }) => ({ path: pathInFolder, hash })));
  }
  return { kind: 'read', answer: files };
}

const cloneGets = async (reads: ModReads, repository: string): Promise<boolean> =>
  !('lacks' in await reads.submodule(repository)) || reads.sourceFolderTracked(repository);

/** What a mod's status reads of the instance besides its manifest and the files git holds in it; a read that rejects
 *  leaves the rest unreadable. Nothing of the folder is read when no manifest is `asked` for. */
export async function modValueOver(reads: ModReads, folder: string, asked: PackagesAsked | undefined, heldByGit: readonly string[]): Promise<StatusValues> {
  if (asked === undefined) return { kind: 'notAsked' };
  try {
    const folderValue = await unheldFolderValueOver(reads, heldByGit, folder);
    const downloadedFiles = new Map<string, FileRead<InstallationFile | undefined>>();
    for (const name of asked.installationFiles) downloadedFiles.set(name, await reads.downloadedFile(name));
    const gameFiles: FileRead<HashedPath[] | undefined> = asked.gameFiles === undefined ? { kind: 'read', answer: [] } : await gameFilesOver(reads, folder, asked.gameFiles);
    if (gameFiles.kind === 'unreadable') return { kind: 'unreadable', reason: gameFiles.reason };
    const flaggedHashes = new Map<string, string>();
    for (const { path, hash, flags } of asked.flagged ?? []) {
      const flaggedHash = await reads.flaggedHash(hash, flags);
      if (flaggedHash !== undefined) flaggedHashes.set(path, flaggedHash);
    }
    const repositoryHosted = asked.repository !== undefined && await cloneGets(reads, asked.repository);
    return { kind: 'read', folder: folderValue, downloadedFiles, gameFiles: gameFiles.answer, flaggedHashes, repositoryHosted };
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
}
