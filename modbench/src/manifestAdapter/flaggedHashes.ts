import { join } from 'node:path';
import { failureReason, isReadFailed, type ReadFailed } from '../wire/readFailed';
import type { FolderValue, PluginFlags } from '../repositoriesLib/statusValues';
import type { Manifest } from './manifest';
import { folderAgainst, type FlaggedHashes } from './modStatus';

/** What asks mEdit for the hashes each plugin file could have had before its flags. */
export type PossibleHashes = (files: readonly { readonly path: string; readonly flags: PluginFlags }[]) =>
  Promise<readonly { readonly path: string; readonly hashes: readonly string[] }[] | ReadFailed>;

/** The hashes each flagged plugin that `folder`, at `at`, holds could have had before its flags, by its manifest path; none
 *  when `possible` is absent or cannot answer, with why. */
export async function flaggedHashesIn(
  manifest: Manifest, folder: FolderValue, at: string, possible: PossibleHashes | undefined,
): Promise<FlaggedHashes | { readonly cannotTell: string }> {
  const held = folderAgainst(manifest, folder).files.flatMap(({ path, hash, pathInFolder }) => {
    const flags = manifest.flags.get(path);
    return flags === undefined || pathInFolder === undefined || typeof hash !== 'string' ? [] : [{ path, at: join(at, pathInFolder), flags }];
  });
  if (held.length === 0) return new Map();
  if (possible === undefined) return { cannotTell: 'its manifest sets flags, which need mEdit' };
  const answered = await possible(held.map(({ at: path, flags }) => ({ path, flags })));
  if (isReadFailed(answered)) return { cannotTell: failureReason(answered) };
  const byPath = new Map(answered.map(({ path, hashes }) => [path, hashes]));
  const unanswered = held.filter(({ at: where }) => !byPath.has(where));
  if (unanswered.length > 0) return { cannotTell: `mEdit answered nothing for ${unanswered.map(({ path }) => `'${path}'`).join(', ')}` };
  return new Map(held.map(({ path, at: where }) => [path, byPath.get(where) ?? []]));
}
