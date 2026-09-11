// modlist.txt gesture commands (ADR-0015 invariant 2): a free function per gesture, taking the
// instance root, the profile and its own inputs, returning applied or a refusal. No class,
// no interface, no base type.

import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  deleteSeparatorInText,
  insertModAtWinningEnd,
  insertSeparatorAtIndexInText,
  moveModInText,
  moveModToSeparatorEndInText,
  moveSeparatorBlockInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  setEnabledInText,
  unlistedModNames,
  deadModEntryNames,
} from '../mo2/modlistText';
import { setUninstalledInText } from '../mo2/downloads';
import { downloadFile, downloadSidecarFile, modDir, modMetaFile, modlistFile, modsDir } from '../mo2/layout';
import { parseMetaIni } from '../mo2/metaIni';
import type { ModlistEntry } from '../model';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the modlist.txt watcher. */
export type ModlistCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

// The one queue every modlist.txt write for an instance passes through — module-private
// infrastructure, not an abstraction over commands. Keyed by instance root, so every profile
// under it serializes together.
const modlistWriteQueues = new Map<string, Promise<unknown>>();

export function withModlistWriteLock<T>(instanceRoot: string, task: () => Promise<T>): Promise<T> {
  const prior = modlistWriteQueues.get(instanceRoot) ?? Promise.resolve();
  const next = prior.then(task, task);
  // The chain tail must never stay rejected, or every later write on this instance queues
  // behind a dead link forever — only the caller's own `next` sees the error.
  modlistWriteQueues.set(instanceRoot, next.catch(() => undefined));
  return next;
}

// The one splice point every verb below goes through. A thrown "not found" becomes `refusal`
// rather than an exception; unchanged text is not written, so a no-op never fires the watcher.
function spliceModlist(
  instanceRoot: string,
  profile: string,
  transform: (text: string) => string,
): Promise<ModlistCommandResult> {
  return withModlistWriteLock(instanceRoot, async () => {
    const path = modlistFile(instanceRoot, profile);
    try {
      const before = await readFile(path, 'utf8');
      const after = transform(before);
      if (after === before) return { applied: true, wrote: false };
      await writeFile(path, after);
      return { applied: true, wrote: true };
    } catch (err) {
      return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
    }
  });
}

/** Flip a mod's `+`/`-` prefix — the Mods tree checkbox. */
export function setModEnabled(
  instanceRoot: string, profile: string, modName: string, enabled: boolean,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => setEnabledInText(text, modName, enabled));
}

/** Move a mod to `toIndex` among entry lines (drag-reorder). */
export function reorderMod(
  instanceRoot: string, profile: string, modName: string, toIndex: number,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => moveModInText(text, modName, toIndex));
}

/** Insert a new enabled separator after `afterEntryName`; when that entry is itself a
 *  separator, inserts after its last member. */
export function insertSeparator(
  instanceRoot: string, profile: string, name: string, afterEntryName: string,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => {
    const entries = parseModlist(text);
    const entryIdx = entries.findIndex((e) => e.name === afterEntryName);
    if (entryIdx === -1) throw new Error(`Entry not found in modlist: ${afterEntryName}`);
    let afterIndex = entryIdx;
    if (entries[entryIdx].kind === 'separator') {
      for (let i = entryIdx + 1; i < entries.length; i++) {
        if (entries[i].kind === 'separator') break;
        afterIndex = i;
      }
    }
    return insertSeparatorAtIndexInText(text, name, afterIndex);
  });
}

/** Rename a separator in place. */
export function renameSeparator(
  instanceRoot: string, profile: string, oldName: string, newName: string,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => renameSeparatorInText(text, oldName, newName));
}

/** Remove a separator's own line; the mods it wrapped join the section above. */
export function deleteSeparator(instanceRoot: string, profile: string, name: string): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => deleteSeparatorInText(text, name));
}

/** Move a mod to the end of `separatorName`'s section, or the ungrouped tail when null. */
export function moveModToSeparator(
  instanceRoot: string, profile: string, modName: string, separatorName: string | null,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => moveModToSeparatorEndInText(text, modName, separatorName));
}

/** Move a separator and every mod it wraps, as one block, to entry-index `toIndex`. */
export function reorderSeparatorBlock(
  instanceRoot: string, profile: string, separatorName: string, toIndex: number,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => moveSeparatorBlockInText(text, separatorName, toIndex));
}

// Best-effort: a download never installed from, or whose .meta is already gone, is normal.
async function markDownloadUninstalled(instanceRoot: string, modName: string): Promise<void> {
  let archiveFilename: string | undefined;
  try {
    const metaIniText = await readFile(modMetaFile(instanceRoot, modName), 'utf8');
    archiveFilename = parseMetaIni(metaIniText).archiveFilename;
  } catch {
    return;
  }
  if (!archiveFilename) return;
  if (!(await exists(downloadFile(instanceRoot, archiveFilename)))) return;
  const metaPath = downloadSidecarFile(instanceRoot, archiveFilename);
  try {
    let metaText: string;
    try {
      metaText = await readFile(metaPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') metaText = '';
      else throw err;
    }
    await writeFile(metaPath, setUninstalledInText(metaText));
  } catch {
    // Bookkeeping only — never blocks the uninstall itself.
  }
}

/** Removes the modlist.txt entry and the `mods/<name>/` folder. Refuses only when the modlist
 *  has no entry for `modName`; a folder-delete failure afterwards leaves a recoverable orphan. */
export async function uninstallMod(instanceRoot: string, profile: string, modName: string): Promise<ModlistCommandResult> {
  // Reads installationFile first: deleting the folder destroys the link to the source download.
  await markDownloadUninstalled(instanceRoot, modName);
  // De-list before deleting: a failed delete leaves a recoverable orphan, not a dangling entry.
  const outcome = await spliceModlist(instanceRoot, profile, (text) => removeModFromText(text, modName));
  if (!outcome.applied) return outcome;
  await rm(modDir(instanceRoot, modName), { recursive: true, force: true }).catch(() => undefined);
  return outcome;
}

/** A folder under `mods/` plus a disabled modlist.txt line — nothing else. Refuses when `name`
 *  is already a mod folder on disk. */
export async function createEmptyMod(instanceRoot: string, profile: string, name: string): Promise<ModlistCommandResult> {
  const dir = modDir(instanceRoot, name);
  if (await exists(dir)) {
    return { applied: false, refusal: `A mod named "${name}" already exists.` };
  }
  await mkdir(dir, { recursive: true });
  return spliceModlist(instanceRoot, profile, (text) => insertModAtWinningEnd(text, name));
}

/** modlist.txt converges on what `mods/` holds. A missing `mods/` reconciles nothing, so a
 *  malformed workspace can never read as a mass delete. */
export async function reconcileMods(
  instanceRoot: string, profile: string,
): Promise<{ applied: true; added: string[]; pruned: string[] } | { applied: false; refusal: string }> {
  let dirNames: string[];
  try {
    const dirents = await readdir(modsDir(instanceRoot), { withFileTypes: true });
    dirNames = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { applied: true, added: [], pruned: [] };
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
  let entries: ModlistEntry[];
  try {
    entries = parseModlist(await readFile(modlistFile(instanceRoot, profile), 'utf8'));
  } catch (err) {
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
  // insertModAtWinningEnd always lands its new line above whatever is currently first, so
  // inserting in reverse-sorted order leaves the batch ascending top-to-bottom on disk.
  const added = unlistedModNames(dirNames, entries);
  for (const name of [...added].reverse()) {
    const outcome = await spliceModlist(instanceRoot, profile, (text) => insertModAtWinningEnd(text, name));
    if (!outcome.applied) return outcome;
  }
  const pruned = deadModEntryNames(dirNames, entries);
  for (const name of pruned) {
    const outcome = await spliceModlist(instanceRoot, profile, (text) => removeModFromText(text, name));
    if (!outcome.applied) return outcome;
  }
  return { applied: true, added, pruned };
}
