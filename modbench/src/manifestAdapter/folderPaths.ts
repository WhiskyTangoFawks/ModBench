// mods.md, A source mod, story 2: a source mod's exclusions are the modlist's, which its build keeps.

import type { FolderValue } from '../repositoriesLib/statusValues';
import type { Manifest } from './manifest';

/** Whether `exclude` names `path` or a folder above it, as formats/manifest.md matches them: in their case. */
export const isExcludedBy = (exclude: readonly string[], path: string): boolean =>
  exclude.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));

/** The paths a source mod's build excludes: each `folder` excludes, and each `manifest` excludes that holds no file `folder`
 *  holds included. `folder` holds none to make the folder what `manifest` says. */
export function exclusionsOf(manifest: Pick<Manifest, 'exclude'> | undefined, folder: Pick<FolderValue, 'files' | 'exclude'>): string[] {
  const included = [...folder.files.values()].flatMap(({ path, excluded }) => (excluded ? [] : [path]));
  const recorded = (manifest?.exclude ?? []).filter((excluded) => !included.some((path) => isExcludedBy([excluded], path)));
  return [...new Set([...recorded, ...folder.exclude])].sort();
}

/** Each file of `folder` by its own path, with its hash; or why the folder's files are not one manifest's: a file that could
 *  not be read, or two files the folder holds at one own path. */
export function ownFilesOf(folder: Pick<FolderValue, 'files'>): ReadonlyMap<string, string> | { readonly why: string } {
  const files = new Map<string, string>();
  const heldAt = new Map<string, string>();
  for (const [pathInFolder, { path, read }] of folder.files) {
    if (read.kind === 'unreadable') return { why: `a file could not be read: ${read.reason}` };
    const other = heldAt.get(path.toLowerCase());
    if (other !== undefined) return { why: `its folder holds '${other}' and '${pathInFolder}', which a manifest names as one file` };
    heldAt.set(path.toLowerCase(), pathInFolder);
    files.set(path, read.answer.hash);
  }
  return files;
}
