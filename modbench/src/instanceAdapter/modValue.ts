import { join } from 'node:path';
import { errorMessage } from '../ports/errorMessage';
import type { FolderValue, PackagesAsked, StatusValues } from '../repositoriesLib/statusValues';
import type { FileRead, InstallationFile, InstanceAdapter } from './instanceAdapter';

type FolderReads = Pick<InstanceAdapter, 'filesIn' | 'originFileHash' | 'fileStamp'>;

const otherCase = (path: string): string => path.replace(/\p{L}/gu, (char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()));

/** `folder`'s files with their hashes, each kept in the hash index (ADR-0013). */
export async function folderValueOver(reads: FolderReads, folder: string): Promise<FolderValue> {
  const paths = await reads.filesIn(folder);
  const files = new Map<string, FileRead<{ readonly size: number; readonly hash: string }>>();
  for (const path of paths) files.set(path, await reads.originFileHash(join(folder, path)));
  const holdsCasePair = new Set(paths.map((path) => path.toLowerCase())).size < paths.length;
  const cased = holdsCasePair ? undefined : paths.find((path) => otherCase(path) !== path);
  return { files, ignoresCase: cased !== undefined && (await reads.fileStamp(join(folder, otherCase(cased)))).kind === 'read' };
}

type ModReads = FolderReads & Pick<InstanceAdapter, 'modMetadata' | 'packageEntries' | 'downloadedFile' | 'gameFolder'>;

/** What a mod's status reads of the instance besides its manifest; a read that rejects leaves the rest unreadable. Nothing
 *  of the folder is read when no manifest is `asked` for, or the metadata cannot be read. */
export async function modValueOver(reads: ModReads, mod: string, folder: string, asked: PackagesAsked | undefined): Promise<StatusValues> {
  const metadata = await reads.modMetadata(mod);
  if (asked === undefined || metadata.kind === 'unreadable') return { metadata, kind: 'metadataOnly' };
  try {
    const folderValue = await folderValueOver(reads, folder);
    const packageEntries = new Map<string, ReadonlyMap<string, string>>();
    for (const key of asked.entries) {
      const entries = await reads.packageEntries(key);
      if (entries !== undefined) packageEntries.set(key, entries);
    }
    const downloadedFiles = new Map<string, FileRead<InstallationFile | undefined>>();
    for (const name of asked.installationFiles) downloadedFiles.set(name, await reads.downloadedFile(name));
    return { metadata, kind: 'read', folder: folderValue, packageEntries, downloadedFiles, gameFolder: await reads.gameFolder() };
  } catch (err) {
    return { metadata, kind: 'unreadable', reason: errorMessage(err) };
  }
}
