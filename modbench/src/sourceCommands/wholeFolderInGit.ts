// commands.md, version in git: the mod's whole folder in the instance repository. The folder's files are let into the
// ignore list, so git holds everything its manifest recorded and the manifest goes to the trash (ADR-0022).

import type { Message } from '../ports/phrase';
import type { VersionInGitOutcome, VersionInGitProgress, WriteRefused } from '../client';
import type { InstanceAdapter } from '../instanceAdapter/instanceAdapter';
import { manifestsIn, sourceModsOf, type SourceMods } from '../manifestAdapter/manifestAdapter';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import { heldManifestIn } from './heldManifest';
import { NO_INSTANCE_REPOSITORY } from './newRepository';
import { setAsideHeldWhole } from './setAsideHeldWhole';

type Adapter = Pick<InstanceAdapter,
  'repositoryOnDisk' | 'modOrder' | 'entryKey' | 'sourceModFolders' | 'modFolderPath' | 'foldersHeldWhole' | 'writeHeldWholeLines' | 'trashFileIn' | 'commitFolder'>;

interface WholeFolderRequest {
  readonly mods: readonly string[];
  readonly commit: boolean;
  readonly onProgress?: (status: { readonly mod: string; readonly modsDone: number; readonly modsTotal: number; readonly phase?: VersionInGitProgress['phase'] }) => void;
}

// Files a manifest ignores would be held, and a line leaving them out would leave the folder not whole
// (instance-repository.md, The manifest, story 11).
async function whyNotWhole(mod: string, folder: string, sourceMods: SourceMods): Promise<string | undefined> {
  if (sourceMods.folderOf(mod) !== undefined) return 'is a source mod, which git holds by its source folder';
  const manifest = await heldManifestIn(folder);
  if (manifest === undefined) return undefined;
  if ('why' in manifest) return manifest.why;
  return manifest.ignore.length === 0 ? undefined : `its manifest ignores ${manifest.ignore.join(', ')}, which git would then hold`;
}

async function foldersToHold(adapter: Adapter, mods: readonly string[]): Promise<{ folders: Map<string, string>; refused: ItemRefusal<string>[] }> {
  const sourceMods = await sourceModsOf((await adapter.modOrder()).modFolders, await adapter.sourceModFolders(), (name) => adapter.entryKey({ kind: 'mod', name }));
  const unheld = await setAsideHeldWhole(adapter, mods, undefined, { takes: () => true, everyMod: false, reason: 'is held whole by git already' });
  const folders = new Map<string, string>();
  const refused: ItemRefusal<string>[] = [...unheld.refused];
  for (const mod of unheld.rest) {
    const folder = await adapter.modFolderPath(mod);
    if (folder === undefined) {
      refused.push({ item: mod, reason: 'its name gives it no folder' });
      continue;
    }
    const reason = await whyNotWhole(mod, folder, sourceMods);
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

interface HeldFolder { readonly mod: string; readonly folder: string; readonly held: boolean }

async function whyNotLanded(
  adapter: Adapter, trash: MoveToTrash, { mod, folder, held }: HeldFolder, commit: boolean, committing: () => void,
): Promise<string | undefined> {
  if (!held) return `its folder is still left out by git, though the ignore list lets it in, such as by .git/info/exclude.${await folderTakenBack(adapter, folder)}`;
  const notTrashed = await manifestsTrashed(adapter, trash, folder);
  if (notTrashed !== undefined) return `its manifest could not go to the trash: ${notTrashed}${await folderTakenBack(adapter, folder)}`;
  if (!commit) return undefined;
  committing();
  const notCommitted = await adapter.commitFolder(folder, `Init ${mod}`).then(() => undefined, errorMessage);
  return notCommitted === undefined ? undefined : `was put under git, but could not be committed: ${notCommitted}`;
}

/** A mod is refused here, naming why, when git holds it by its source folder or whole already, its manifest ignores files
 *  or cannot go to the trash, or git still leaves its folder out; the rest land. */
export async function modsPutWholeInGit(
  adapter: Adapter, trash: MoveToTrash, { mods, commit, onProgress }: WholeFolderRequest,
): Promise<VersionInGitOutcome | WriteRefused<Message>> {
  if (!(await adapter.repositoryOnDisk())) return { refused: true, message: NO_INSTANCE_REPOSITORY };
  const { folders, refused } = await foldersToHold(adapter, mods);
  if (folders.size === 0) return { landed: [], refused };
  // git adds nothing the ignore list leaves out, so the folders are let in first.
  const notLetIn = await adapter.writeHeldWholeLines([...folders.values()], true).then(() => undefined, errorMessage);
  if (notLetIn !== undefined) return { landed: [], refused: [...refused, ...[...folders.keys()].map((item) => ({ item, reason: notLetIn }))] };
  const held = await adapter.foldersHeldWhole([...folders.values()]);
  const landed: VersionInGitOutcome['landed'][number][] = [];
  for (const [at, [mod, folder]] of [...folders].entries()) {
    const progress = { mod, modsDone: at, modsTotal: folders.size };
    onProgress?.(progress);
    const why = await whyNotLanded(adapter, trash, { mod, folder, held: held.has(folder) }, commit, () => { onProgress?.({ ...progress, phase: 'Committing' }); });
    if (why === undefined) landed.push({ mod, plugins: [] });
    else refused.push({ item: mod, reason: why });
  }
  return { landed, refused };
}
