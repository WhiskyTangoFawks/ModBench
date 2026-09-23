// modlist.txt gesture commands (ADR-0015 invariant 2): a free function per gesture, taking the
// instance root, the profile and its own inputs, returning applied or a refusal. No class,
// no interface, no base type.

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
  separatorBlockNames,
  setEnabledInText,
  unlistedModNames,
} from '../mo2Codecs/modlistText';
import { dropIndexIn, type Drop } from '../mo2Codecs/dropIndex';
import { setUninstalledInText } from '../mo2Codecs/downloads';
import { downloadFile, downloadSidecarFile, modDir, modlistFile, modsDir } from '../instanceAdapter/layout';
import { ensureDir, exists, put, putIfChanged, remove } from '../instanceAdapter/files';
import { present } from '../ports/present';
import { refuse } from '../ports/refuse';

/** `wrote` is false when the gesture was already true of the file: a command that changes no
 *  byte writes none, so it never fires the modlist.txt watcher. */
export type ModlistCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

// The one splice point every verb below goes through. A thrown "not found" becomes `refusal`
// rather than an exception; unchanged text is not written, so a no-op never fires the watcher.
async function spliceModlist(
  instanceRoot: string,
  profile: string,
  transform: (text: string) => string,
): Promise<ModlistCommandResult> {
  try {
    const { wrote } = await putIfChanged(modlistFile(instanceRoot, profile), transform);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** Flip a mod's `+`/`-` prefix — the Mods tree checkbox. */
export function setModEnabled(
  instanceRoot: string, profile: string, modName: string, enabled: boolean,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => setEnabledInText(text, modName, enabled));
}

/** Where a drag landed in the Mods tree. Re-exported so the view names the drop without naming
 *  the codec that settles it into an index. */
export type { Drop as ModlistDrop } from '../mo2Codecs/dropIndex';

// Settled against the text the splice is about to rewrite, so a tree a generation behind
// modlist.txt cannot land the block at a stale index.
const entryIndexOf = (text: string, movedNames: readonly string[], drop: Drop): number =>
  dropIndexIn(parseModlist(text).map((e) => e.name), movedNames, drop);

/** Move a mod to where the drag landed. */
export function reorderMod(
  instanceRoot: string, profile: string, modName: string, drop: Drop,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) =>
    moveModInText(text, modName, entryIndexOf(text, [modName], drop)));
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
    const afterEntry = present(entries[entryIdx], `modlist entry at index ${entryIdx}`);
    let afterIndex = entryIdx;
    if (afterEntry.kind === 'separator') {
      for (const [i, entry] of [...entries.entries()].slice(entryIdx + 1)) {
        if (entry.kind === 'separator') break;
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

/** Move a separator and every mod it wraps, as one block, to where the drag landed. */
export function reorderSeparatorBlock(
  instanceRoot: string, profile: string, separatorName: string, drop: Drop,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => moveSeparatorBlockInText(
    text, separatorName, entryIndexOf(text, separatorBlockNames(parseModlist(text), separatorName), drop)));
}

// A mod outlives its download, so an archive that is gone is left alone: a sidecar beside no
// archive is one MO2 never writes. `installed` stays, as MO2 leaves it — the codec resolves the
// keys' precedence.
async function unmarkDownload(instanceRoot: string, name: string): Promise<void> {
  if (!(await exists(downloadFile(instanceRoot, name)))) return;
  await put(downloadSidecarFile(instanceRoot, name), setUninstalledInText, { ifMissing: '' });
}

/** Removes the modlist.txt entry and the `mods/<name>/` folder. Refuses only when the modlist
 *  has no entry for `modName`. `archiveFilename` is the mod row's own `installationFile`, handed
 *  in from the value; with none, no download is unmarked. */
export async function uninstallMod(
  instanceRoot: string, profile: string, modName: string, archiveFilename?: string,
): Promise<ModlistCommandResult> {
  // Bookkeeping over a download that may be long gone — never blocks the uninstall.
  if (archiveFilename) await unmarkDownload(instanceRoot, archiveFilename).catch(() => undefined);
  // De-list before deleting: a failed delete leaves a recoverable orphan, not a dangling entry.
  const outcome = await spliceModlist(instanceRoot, profile, (text) => removeModFromText(text, modName));
  if (!outcome.applied) return outcome;
  await remove(modDir(instanceRoot, modName)).catch(() => undefined);
  return outcome;
}

/** A folder under `mods/` plus a disabled modlist.txt line — nothing else. `modFolders` is the
 *  value's own listing of `mods/`, handed in rather than read here, and a name already among
 *  them is refused. */
export async function createEmptyMod(
  instanceRoot: string, profile: string, name: string, modFolders: readonly string[],
): Promise<ModlistCommandResult> {
  if (modFolders.includes(name)) {
    return { applied: false, refusal: `A mod named "${name}" already exists.` };
  }
  await ensureDir(modDir(instanceRoot, name));
  return spliceModlist(instanceRoot, profile, (text) => insertModAtWinningEnd(text, name));
}

export type ModSyncResult =
  | { applied: true; added: string[]; dropped: string[] }
  | { applied: false; refusal: string };

/** `modbench.mod.sync`: a disabled winning-end line for each folder with none, and each mod line
 *  whose folder is gone dropped, in one write. `modFolders` is undefined when there is no `mods/`
 *  to list, and that is refused. */
export async function syncMods(
  instanceRoot: string, profile: string, modFolders: readonly string[] | undefined,
): Promise<ModSyncResult> {
  if (modFolders === undefined) {
    return { applied: false, refusal: `${modsDir(instanceRoot)} does not exist, so modlist.txt is left as it is.` };
  }
  let added: string[] = [];
  let dropped: string[] = [];
  const outcome = await spliceModlist(instanceRoot, profile, (text) => {
    // Read inside the write lock: two values can hand over the same folders before the first
    // write comes back, and only the text about to be spliced says what is still to do.
    const entries = parseModlist(text);
    const folders = new Set(modFolders);
    added = unlistedModNames([...modFolders], entries);
    dropped = entries.filter((e) => e.kind === 'mod' && !folders.has(e.name)).map((e) => e.name);
    // insertModAtWinningEnd always lands its new line above whatever is currently first, so
    // inserting in reverse order leaves the batch ascending top-to-bottom on disk.
    const withoutGone = dropped.reduce((out, name) => removeModFromText(out, name), text);
    return [...added].reverse().reduce((out, name) => insertModAtWinningEnd(out, name), withoutGone);
  });
  return outcome.applied ? { applied: true, added, dropped } : outcome;
}
