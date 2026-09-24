// modlist.txt gesture commands (ADR-0015 invariant 2): a free function per gesture, taking the
// instance root, the profile and its own inputs, returning applied or a refusal. No class,
// no interface, no base type.

import {
  deleteSeparatorInText,
  insertModAtWinningEnd,
  insertSeparatorAtIndexInText,
  moveModInText,
  moveModsInText,
  moveSeparatorsInText,
  moveSeparatorBlockInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  separatorBlockNames,
  setEnabledInText,
  unlistedModNames,
  type ModsPlace,
} from '../mo2Codecs/modlistText';
import { dropIndexIn, type Drop } from '../mo2Codecs/dropIndex';
import { setUninstalledInText } from '../mo2Codecs/downloads';
import { downloadFile, downloadSidecarFile, modDir, modlistFile, modsDir } from '../instanceAdapter/layout';
import { ensureDir, exists, put, putIfChanged, remove } from '../instanceAdapter/files';
import { present } from '../ports/present';
import { refuse } from '../ports/refuse';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';

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

/** A gesture over a selection, in one splice: each item landed or refused by name, or the whole
 *  selection refused once when modlist.txt cannot be read or written. */
export type ModlistSelectionResult =
  | { applied: true; outcome: SelectionOutcome<string> }
  | { applied: false; refusal: string };

type EntryKind = 'mod' | 'separator';

// Read inside the write lock, so an item gone since the view last rendered is refused by name
// while the rest land in the same write.
async function spliceSelection(
  instanceRoot: string, profile: string, kind: EntryKind, names: readonly string[],
  transform: (text: string, found: readonly string[]) => string,
): Promise<ModlistSelectionResult> {
  const noun = kind === 'mod' ? 'Mod' : 'Separator';
  let landed: string[] = [];
  let refused: ItemRefusal<string>[] = [];
  const outcome = await spliceModlist(instanceRoot, profile, (text) => {
    const known = new Set(parseModlist(text).filter((e) => e.kind === kind).map((e) => e.name));
    landed = names.filter((name) => known.has(name));
    refused = names.filter((name) => !known.has(name))
      .map((name) => ({ item: name, reason: `${noun} not found in modlist: ${name}` }));
    return transform(text, landed);
  });
  return outcome.applied ? { applied: true, outcome: { landed, refused } } : outcome;
}

/** `modbench.mod.enable` / `modbench.mod.disable`, over the whole selection in one splice. */
export function setModsEnabled(
  instanceRoot: string, profile: string, modNames: readonly string[], enabled: boolean,
): Promise<ModlistSelectionResult> {
  return spliceSelection(instanceRoot, profile, 'mod', modNames, (text, found) =>
    found.reduce((acc, name) => setEnabledInText(acc, name, enabled), text));
}

export type { ModsPlace } from '../mo2Codecs/modlistText';

/** `modbench.mod.move` over mods (mods.md, Pickers, Move): they land as one block, in their own
 *  order. A separator that has gone refuses the whole move. */
export function moveMods(
  instanceRoot: string, profile: string, modNames: readonly string[], place: ModsPlace,
): Promise<ModlistSelectionResult> {
  return spliceSelection(instanceRoot, profile, 'mod', modNames, (text, found) =>
    moveModsInText(text, found, place));
}

/** `modbench.mod.move` over separators (mods.md, Pickers, Move): each brings every mod it holds,
 *  and they land directly above the target, as shown. A target that has gone refuses the whole
 *  move. */
export function moveSeparators(
  instanceRoot: string, profile: string, separatorNames: readonly string[], targetName: string,
): Promise<ModlistSelectionResult> {
  return spliceSelection(instanceRoot, profile, 'separator', separatorNames, (text, found) =>
    moveSeparatorsInText(text, found, targetName));
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

/** Insert a new enabled separator next to the anchor (mods.md, Add separator): on a mod, directly
 *  after it; on a separator, before its own group's winning-most member. */
export function insertSeparator(
  instanceRoot: string, profile: string, name: string, anchorName: string,
): Promise<ModlistCommandResult> {
  return spliceModlist(instanceRoot, profile, (text) => {
    const entries = parseModlist(text);
    const entryIdx = entries.findIndex((e) => e.name === anchorName);
    if (entryIdx === -1) throw new Error(`Entry not found in modlist: ${anchorName}`);
    const anchorEntry = present(entries[entryIdx], `modlist entry at index ${entryIdx}`);
    let afterIndex = entryIdx;
    if (anchorEntry.kind === 'separator') {
      let groupStart = entryIdx;
      for (let i = entryIdx - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || entry.kind === 'separator') break;
        groupStart = i;
      }
      afterIndex = groupStart - 1;
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

/** `lineRefusal` is set only when the folder landed and the line did not: the folder stays, and
 *  `mod sync` adopts it next (common.md, Reporting: "A gesture landed, but part of it failed"). */
export type CreateEmptyModResult =
  | { applied: true; wrote: boolean; lineRefusal?: string }
  | { applied: false; refusal: string };

// Matches install's modNameCollisionRefusal word for word (mods.md: one wording for create and
// install). Not imported: modlist and install are sibling Core boxes with no reference between
// them in target-architecture-references.d2.
function nameCollisionRefusal(name: string): string {
  return `A mod named "${name}" already exists — install its next release from the Downloads view instead.`;
}

/** A folder under `mods/` plus a disabled modlist.txt line — nothing else. `modFolders` is the
 *  value's own listing of `mods/`, handed in rather than read here, and a name already among
 *  them is refused. */
export async function createEmptyMod(
  instanceRoot: string, profile: string, name: string, modFolders: readonly string[],
): Promise<CreateEmptyModResult> {
  if (modFolders.includes(name)) {
    return { applied: false, refusal: nameCollisionRefusal(name) };
  }
  await ensureDir(modDir(instanceRoot, name));
  // Read inside the write lock, so a line mod sync already added for this name is left alone
  // rather than doubled.
  const line = await spliceModlist(instanceRoot, profile, (text) => {
    const alreadyListed = parseModlist(text).some((e) => e.kind === 'mod' && e.name === name);
    return alreadyListed ? text : insertModAtWinningEnd(text, name);
  });
  if (!line.applied) return { applied: true, wrote: false, lineRefusal: line.refusal };
  return { applied: true, wrote: line.wrote };
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
