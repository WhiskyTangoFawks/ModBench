import type { FileRead } from '../instanceAdapter/instanceAdapter';
import { packageHolds, type HashedPath } from '../manifestAdapter/manifestAdapter';

/** What an archive holds, as the instance value says: its entries' paths, or why not, or not yet. */
export type ArchiveEntries = FileRead<readonly string[]> | { readonly kind: 'unanswered' };

/** The hash of each of `entries` in `archive`, in order. */
export type HashEntries = (gameName: string, archive: string, entries: readonly string[]) => Promise<FileRead<string>[]>;

export type EntriesNoPackageHolds = FileRead<readonly string[]>;

/** The entries of an archive that no one of `packageFiles` holds, by file name or by bytes. Only an entry no package file
 *  names is hashed. */
export async function entriesNoPackageHolds(
  gameName: string, archive: string, contents: FileRead<readonly string[]>, packageFiles: readonly HashedPath[], hashEntries: HashEntries,
): Promise<EntriesNoPackageHolds> {
  if (contents.kind === 'unreadable' || packageFiles.length === 0) return contents;
  const holds = packageHolds(packageFiles);
  const unnamed = contents.answer.filter((entry) => !holds.name(entry));
  const hashed = unnamed.length === 0 ? [] : await hashEntries(gameName, archive, unnamed);
  const failed = hashed.find((read) => read.kind === 'unreadable');
  if (failed?.kind === 'unreadable') return failed;
  return { kind: 'read', answer: unnamed.filter((_, at) => { const read = hashed[at]; return read?.kind !== 'read' || !holds.bytes(read.answer); }) };
}
