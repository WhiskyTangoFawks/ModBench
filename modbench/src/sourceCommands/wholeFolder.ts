// commands.md, version in git: the mod's whole folder in the modlist repository. The folder's files are let into the
// ignore list, so git holds everything its manifest recorded and the manifest goes to the trash (ADR-0022).

import type { VersionInGitOutcome, WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestsIn, sourceModsOf } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { NO_MODLIST_REPOSITORY } from './newRepository';

type Adapter = Pick<InstanceAdapter,
  'repositoryOnDisk' | 'modOrder' | 'entryKey' | 'sourceModFolders' | 'modFolderPath' | 'foldersHeldWhole' | 'writeHeldWholeLines' | 'trashFileIn' | 'commitFolder'>;

interface HeldWholeRequest {
  readonly mods: readonly string[];
  readonly commit: boolean;
  readonly onProgress?: (status: { readonly mod: string; readonly modsDone: number; readonly modsTotal: number }) => void;
}

// A mod git cannot hold whole is refused, naming why.
async function foldersToHold(adapter: Adapter, mods: readonly string[]): Promise<{ folders: Map<string, string>; refused: ItemRefusal<string>[] }> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const found = await Promise.all(mods.map(async (mod) => [mod, await adapter.modFolderPath(mod)] as const));
  const held = await adapter.foldersHeldWhole(found.flatMap(([, folder]) => (folder === undefined ? [] : [folder])));
  const folders = new Map<string, string>();
  const refused: ItemRefusal<string>[] = [];
  for (const [mod, folder] of found) {
    if (folder === undefined) {
      refused.push({ item: mod, reason: 'its name gives it no folder' });
      continue;
    }
    const reason = sourceMods.folderOf(mod) !== undefined ? 'is a source mod, which git holds by its source folder' : held.has(folder) ? 'is held whole by git already' : undefined;
    if (reason === undefined) folders.set(mod, folder);
    else refused.push({ item: mod, reason });
  }
  return { folders, refused };
}

async function manifestsTrashed(adapter: Pick<Adapter, 'trashFileIn'>, trash: MoveToTrash, folder: string): Promise<string | undefined> {
  try {
    for (const name of await manifestsIn(folder)) {
      const why = await adapter.trashFileIn(folder, name, trash);
      if (why !== undefined) return why;
    }
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

async function folderTakenBack(adapter: Pick<Adapter, 'writeHeldWholeLines'>, folder: string): Promise<string> {
  return adapter.writeHeldWholeLines([folder], false).then(
    () => '', (err: unknown) => ` The ignore list still lets in ${folder}: ${errorMessage(err)}`);
}

/** Version in git for a mod's whole folder. A mod git holds by its source folder or holds whole already, or whose manifest
 *  cannot go to the trash, is refused, naming why; the rest land. */
export async function modsHeldWhole(adapter: Adapter, trash: MoveToTrash, { mods, commit, onProgress }: HeldWholeRequest): Promise<VersionInGitOutcome | WriteRefused> {
  if (!(await adapter.repositoryOnDisk())) return { refused: true, message: NO_MODLIST_REPOSITORY };
  const { folders, refused } = await foldersToHold(adapter, mods);
  if (folders.size === 0) return { landed: [], refused };
  // git adds nothing the ignore list leaves out, so the folders are let in first.
  const notLetIn = await adapter.writeHeldWholeLines([...folders.values()], true).then(() => undefined, errorMessage);
  if (notLetIn !== undefined) return { landed: [], refused: [...refused, ...[...folders.keys()].map((item) => ({ item, reason: notLetIn }))] };
  const landed: VersionInGitOutcome['landed'][number][] = [];
  for (const [at, [mod, folder]] of [...folders].entries()) {
    onProgress?.({ mod, modsDone: at, modsTotal: folders.size });
    const notTrashed = await manifestsTrashed(adapter, trash, folder);
    if (notTrashed !== undefined) {
      refused.push({ item: mod, reason: `its manifest could not go to the trash: ${notTrashed}${await folderTakenBack(adapter, folder)}` });
      continue;
    }
    const notCommitted = commit ? await adapter.commitFolder(folder, `Init ${mod}`).then(() => undefined, errorMessage) : undefined;
    if (notCommitted === undefined) landed.push({ mod, plugins: [] });
    else refused.push({ item: mod, reason: `was put under git, but could not be committed: ${notCommitted}` });
  }
  return { landed, refused };
}
