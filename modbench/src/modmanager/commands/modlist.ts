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
  setEnabledInText,
} from '../../mo2Codecs/modlistText';
import { markDownloadUninstalled } from './downloads';
import { modDir, modlistFile } from '../../mo2Files/layout';
import { ensureDir, exists, putIfChanged, remove } from '../../mo2Files/files';
import { present } from '../../ports/present';

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
    return { applied: false, refusal: err instanceof Error ? err.message : String(err) };
  }
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

/** Move a separator and every mod it wraps, as one block, to entry-index `toIndex`. */
export function reorderSeparatorBlock(
  instanceRoot: string, profile: string, separatorName: string, toIndex: number,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => moveSeparatorBlockInText(text, separatorName, toIndex));
}

/** Removes the modlist.txt entry and the `mods/<name>/` folder. Refuses only when the modlist
 *  has no entry for `modName`. `archiveFilename` is the mod row's own `installationFile`, handed
 *  in from the value; with none, no download is marked. */
export async function uninstallMod(
  instanceRoot: string, profile: string, modName: string, archiveFilename?: string,
): Promise<ModlistCommandResult> {
  // Bookkeeping, and refused when the download is already gone — never blocks the uninstall.
  if (archiveFilename) await markDownloadUninstalled(instanceRoot, archiveFilename);
  // De-list before deleting: a failed delete leaves a recoverable orphan, not a dangling entry.
  const outcome = await spliceModlist(instanceRoot, profile, (text) => removeModFromText(text, modName));
  if (!outcome.applied) return outcome;
  await remove(modDir(instanceRoot, modName)).catch(() => undefined);
  return outcome;
}

/** A folder under `mods/` plus a disabled modlist.txt line — nothing else. Refuses when `name`
 *  is already a mod folder on disk. */
export async function createEmptyMod(instanceRoot: string, profile: string, name: string): Promise<ModlistCommandResult> {
  const dir = modDir(instanceRoot, name);
  if (await exists(dir)) {
    return { applied: false, refusal: `A mod named "${name}" already exists.` };
  }
  await ensureDir(dir);
  return spliceModlist(instanceRoot, profile, (text) => insertModAtWinningEnd(text, name));
}

/** The value's unlisted folders get a line each, disabled, at the winning end, in one write.
 *  Which folders need one is the value's answer, never a command's (ADR-0015 invariant 1). */
export async function adoptMods(
  instanceRoot: string, profile: string, folderNames: readonly string[],
): Promise<{ applied: true; added: string[] } | { applied: false; refusal: string }> {
  let added: string[] = [];
  const outcome = await spliceModlist(instanceRoot, profile, (text) => {
    // Read off the text about to be spliced, inside the write lock: two landed values can hand
    // the same folder over before the first write comes back, and only this refuses the second
    // line.
    const listed = new Set(parseModlist(text).filter((e) => e.kind !== 'separator').map((e) => e.name));
    added = [...folderNames].filter((name) => !listed.has(name)).sort((a, b) => a.localeCompare(b));
    // insertModAtWinningEnd always lands its new line above whatever is currently first, so
    // inserting in reverse order leaves the batch ascending top-to-bottom on disk.
    return [...added].reverse().reduce(insertModAtWinningEnd, text);
  });
  return outcome.applied ? { applied: true, added } : outcome;
}
