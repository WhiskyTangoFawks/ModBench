// formats/manifest.md, `flags`: a plugin the manifest flags is its package's copy once its flags are cleared back.

import { join } from 'node:path';
import type { FolderFile, FolderValue } from '../repositoriesLib/statusValues';
import type { Manifest } from './manifest';

/** A plugin's bytes with some of its flags flipped: the values those flags then hold, and the hash of the bytes. */
interface FlagVariant {
  readonly flags: Readonly<Record<string, boolean>>;
  readonly hash: string;
}

/** The variants of each plugin file at `paths`; rejects with why it could not read them. */
export type FlagVariantsOf = (paths: readonly string[]) => Promise<ReadonlyMap<string, readonly FlagVariant[]>>;

const folded = (path: string): string => path.toLowerCase();

const clearedBack = (flags: Readonly<Record<string, boolean>>): [string, boolean][] =>
  Object.entries(flags).map(([name, on]) => [name, !on]);

const isThese = (variant: FlagVariant, flags: readonly [string, boolean][]): boolean =>
  Object.keys(variant.flags).length === flags.length && flags.every(([name, on]) => variant.flags[name] === on);

/** `folder` with each plugin of `manifest.flags` read as its package's copy: the hash of its bytes with the flags cleared
 *  back, or no bytes of the manifest's when it does not carry the flags. */
export async function flagVariantsApplied(
  manifest: Pick<Manifest, 'flags'>, folderPath: string, folder: FolderValue, variantsOf: FlagVariantsOf,
): Promise<FolderValue> {
  if (manifest.flags.size === 0) return folder;
  const flagsOf = new Map([...manifest.flags].map(([path, flags]) => [folded(path), flags]));
  const flagged = [...folder.files].flatMap(([pathInFolder, file]) => {
    const flags = flagsOf.get(folded(file.path));
    return flags === undefined ? [] : [{ pathInFolder, file, flags }];
  });
  if (flagged.length === 0) return folder;
  const variants = await variantsOf(flagged.map(({ pathInFolder }) => join(folderPath, pathInFolder)));
  const files = new Map(folder.files);
  for (const { pathInFolder, file, flags } of flagged) {
    const wanted = clearedBack(flags);
    const variant = variants.get(join(folderPath, pathInFolder))?.find((one) => isThese(one, wanted));
    const read: FolderFile['read'] = variant === undefined
      ? { kind: 'unreadable', reason: 'its flags are not those its manifest sets' }
      : { kind: 'read', answer: { hash: variant.hash } };
    files.set(pathInFolder, { ...file, read });
  }
  return { ...folder, files };
}
