// A mod's folder is linked to its repository by the repository package its manifest names, so a source mod renamed or
// cloned builds where it is (mods.md, Build, story 4).

import { errorMessage } from '../ports/errorMessage';
import { manifestIn } from './manifestFiles';
import { repositoryOf } from './manifestPackages';

/** A folder of the mod manager's mods: a mod's or a separator's, by the name the mod manager knows it by. */
export interface ModFolderAt {
  readonly kind: string;
  readonly modName: string;
  readonly path: string;
}

/** The source mods: each repository's folder by the mod it builds. A note names each folder or repository left out, and why. */
export interface SourceMods {
  readonly folders: ReadonlyMap<string, string>;
  /** The source folder that builds `mod`, its name matched as the mod manager matches names. */
  folderOf(mod: string): string | undefined;
  /** Whether a repository builds `mod`: one its manifest names, cloned or not, or one of its name no manifest names. */
  builds(mod: string): boolean;
  readonly notes: readonly string[];
}

type Link = { readonly repository: string } | { readonly unlinked: true } | { readonly noManifest: true } | { readonly unreadable: string };

async function linkIn(folder: string): Promise<Link> {
  try {
    const read = await manifestIn(folder);
    if (read === undefined) return { noManifest: true };
    if ('refused' in read) return { unreadable: read.refused };
    const repository = repositoryOf(read.manifest)?.name;
    return repository === undefined ? { unlinked: true } : { repository };
  } catch (err) {
    return { unreadable: `its manifest could not be read: ${errorMessage(err)}` };
  }
}

/** Each mod whose manifest names a repository the source folder holds, and each repository no manifest names under its
 *  own name, which its first build gives its folder (mods.md, Build, story 7). `repositories`: each by its name. */
export async function sourceModsOf(
  folders: readonly ModFolderAt[] | undefined, repositories: ReadonlyMap<string, string>, keyOf: (mod: string) => string,
): Promise<SourceMods> {
  const notes: string[] = [];
  const byKey = new Map<string, { readonly mod: string; readonly folder: string }>();
  const named = new Set<string>();
  const manifested = new Map<string, boolean>();
  const linked = new Set<string>();
  for (const { modName: name, path: folder } of (folders ?? []).filter(({ kind }) => kind === 'mod')) {
    const link = await linkIn(folder);
    if ('unreadable' in link) notes.push(`${folder} builds from no repository, as ${link.unreadable}.`);
    if (!('noManifest' in link)) manifested.set(keyOf(name), !('unreadable' in link));
    if (!('repository' in link)) continue;
    named.add(link.repository);
    linked.add(keyOf(name));
    const repository = repositories.get(link.repository);
    if (repository !== undefined) byKey.set(keyOf(name), { mod: name, folder: repository });
  }
  for (const [name, folder] of repositories) {
    const readable = manifested.get(keyOf(name));
    if (named.has(name) || readable === false) continue;
    if (readable === true) notes.push(`${folder} is not a source mod: no manifest names it, and the folder of the mod '${name}' is another mod's.`);
    else if (!byKey.has(keyOf(name))) byKey.set(keyOf(name), { mod: name, folder });
  }
  return {
    folders: new Map([...byKey.values()].map(({ mod, folder }) => [mod, folder])),
    folderOf: (mod) => byKey.get(keyOf(mod))?.folder,
    builds: (mod) => linked.has(keyOf(mod)) || byKey.has(keyOf(mod)),
    notes,
  };
}

/** The source folder uninstalling `mod`, among the mods `uninstalled`, sends to the trash: its own, unless a mod left
 *  behind builds from it too Mods are matched by `keyOf`. */
export function sourceFolderTrashed(
  folders: ReadonlyMap<string, string>, mod: string, uninstalled: readonly string[], keyOf: (mod: string) => string,
): string | undefined {
  const leaving = new Set(uninstalled.map(keyOf));
  const own = [...folders].find(([built]) => keyOf(built) === keyOf(mod))?.[1];
  const shared = [...folders].some(([built, folder]) => folder === own && !leaving.has(keyOf(built)));
  return shared ? undefined : own;
}
