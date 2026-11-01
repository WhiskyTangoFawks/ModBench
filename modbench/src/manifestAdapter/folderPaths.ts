// mods.md, A source mod, story 2: a source mod's exclusions are the modlist's, which its build keeps.

import type { FolderValue } from '../repositoriesLib/statusValues';
import type { Manifest } from './manifest';

/** Whether `named` names `path` or a folder above it, as formats/manifest.md matches `exclude` and `ignore`: in their case. */
export const isUnderAny = (named: readonly string[], path: string): boolean =>
  named.some((one) => path === one || path.startsWith(`${one}/`));

/** The paths of `exclude` that name one of `files` or a folder above one, which are the exclusions a manifest names. */
export const exclusionsOfFiles = (exclude: readonly string[], paths: Iterable<string>): string[] => {
  const files = [...paths];
  return exclude.filter((excluded) => files.some((path) => isUnderAny([excluded], path)));
};

/** The paths a source mod's build excludes: each `folder` excludes, and each `manifest` excludes that holds no file `folder`
 *  holds included. `folder` holds none to make the folder what `manifest` says. */
export function exclusionsOf(manifest: Pick<Manifest, 'exclude'> | undefined, folder: Pick<FolderValue, 'files' | 'exclude'>): string[] {
  const included = [...folder.files.values()].flatMap(({ path, excluded }) => (excluded ? [] : [path]));
  const recorded = (manifest?.exclude ?? []).filter((excluded) => !included.some((path) => isUnderAny([excluded], path)));
  return [...new Set([...recorded, ...folder.exclude])].sort();
}

/** Each file of `folder` by its own path, with its hash, less those `ignore` names; or why they are not one manifest's: a
 *  file that could not be read, or two files at one own path. */
export function ownFilesOf(folder: Pick<FolderValue, 'files'>, ignore: readonly string[] = []): ReadonlyMap<string, string> | { readonly why: string } {
  const files = new Map<string, string>();
  const heldAt = new Map<string, string>();
  for (const [pathInFolder, { path, read }] of folder.files) {
    if (isUnderAny(ignore, path)) continue;
    if (read.kind === 'unreadable') return { why: `a file could not be read: ${read.reason}` };
    const other = heldAt.get(path.toLowerCase());
    if (other !== undefined) return { why: `its folder holds '${other}' and '${pathInFolder}', which a manifest names as one file` };
    heldAt.set(path.toLowerCase(), pathInFolder);
    files.set(path, read.answer.hash);
  }
  return files;
}
