import { join } from 'node:path';
import type { FlaggedPluginFile, FlaggedPluginHashes } from '../wire/messages';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { FolderValue, Read } from '../repositoriesLib/statusValues';
import { isUnderAny } from './folderPaths';
import type { Manifest } from './manifest';
import { folderAgainst, type FlaggedHashes } from './modStatus';

/** What mEdit says a flagged plugin could have held before the manifest's flags; `unanswered` while it has not said. */
export type FlaggedRead = Read<readonly string[]> | { readonly kind: 'unanswered' };

/** What asks mEdit what each plugin file could have held before its flags. */
export type PossibleHashes = (files: readonly FlaggedPluginFile[]) => Promise<readonly FlaggedPluginHashes[] | ReadFailed>;

/** A plugin the manifest flags and the folder holds, by its manifest path, and the file to ask mEdit about. */
export interface FlaggedFile {
  readonly manifestPath: string;
  readonly pathInFolder: string;
  readonly file: FlaggedPluginFile;
}

export function flaggedFilesIn(manifest: Manifest, folder: FolderValue, at: string): FlaggedFile[] {
  return folderAgainst(manifest, folder, new Map()).files.flatMap(({ path, hash, pathInFolder }) => {
    const flags = manifest.flags.get(path);
    return flags === undefined || pathInFolder === undefined || typeof hash !== 'string' ? [] : [{ manifestPath: path, pathInFolder, file: { path: join(at, pathInFolder), flags } }];
  });
}

/** What `held` says of each file, by manifest path; none, with why, when it says of one that it cannot tell. */
export function flaggedHashesFrom(
  files: readonly FlaggedFile[], held: (file: FlaggedFile) => FlaggedRead | undefined,
): FlaggedHashes | { readonly cannotTell: string } {
  const hashes = new Map<string, readonly string[]>();
  for (const flagged of files) {
    const { manifestPath } = flagged;
    const read = held(flagged);
    if (read?.kind === 'unreadable') return { cannotTell: `'${manifestPath}' could not be read: ${read.reason}` };
    if (read?.kind !== 'read') return { cannotTell: `mEdit has not said what '${manifestPath}' could have held before its flags` };
    hashes.set(manifestPath, read.answer);
  }
  return hashes;
}

/** The hashes each flagged plugin that `folder`, at `at`, holds could have had before its flags, as `possible` says, by its
 *  manifest path, limited to those under `only` when it is given; none when `possible` is absent or cannot answer, with why. */
export async function flaggedHashesIn(
  manifest: Manifest, folder: FolderValue, at: string, possible: PossibleHashes | undefined, only?: readonly string[],
): Promise<FlaggedHashes | { readonly cannotTell: string }> {
  const files = flaggedFilesIn(manifest, folder, at).filter(({ manifestPath }) => only === undefined || isUnderAny(only, manifestPath));
  if (files.length === 0) return new Map();
  if (possible === undefined) return { cannotTell: 'its manifest sets flags, which need mEdit' };
  const answered = await possible(files.map(({ file }) => file));
  if (isReadFailed(answered)) return { cannotTell: failureReason(answered) };
  const byPath = new Map(answered.map((one): [string, FlaggedRead] => [one.path, typeof one.unreadable === 'string' ? { kind: 'unreadable', reason: one.unreadable } : { kind: 'read', answer: one.hashes }]));
  return flaggedHashesFrom(files, ({ file }) => byPath.get(file.path));
}
