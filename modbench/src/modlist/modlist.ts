// modlist.txt gesture commands (ADR-0015 invariant 2): a free function per gesture, taking the
// instance root, the profile and its own inputs, returning applied or a refusal. No class,
// no interface, no base type.

import {
  deleteSeparatorInText,
  insertModAtWinningEnd,
  modNameKey,
  insertSeparatorAtIndexInText,
  moveModsInText,
  moveSeparatorsInText,
  parseModlist,
  removeModFromText,
  renameSeparatorInText,
  separatorModName,
  setEnabledInText,
  unlistedModNames,
  type ModlistEntry,
  type MovePlace,
  type OrderEnd,
  type SeparatorsPlace,
} from '../mo2Codecs/modlistText';
import { setUninstalledInText } from '../mo2Codecs/downloads';
import {
  downloadFile, downloadSidecarFile, mo2FolderName, modDir, modlistFile, modsDir, separatorDir,
  separatorFolderName,
} from '../instanceAdapter/layout';
import { ensureDir, exists, get, put, putIfChanged, rename } from '../instanceAdapter/files';
import { present } from '../ports/present';
import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';

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
  transform: (text: string) => string | Promise<string>,
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

export type { MovePlace, OrderEnd, SeparatorsPlace } from '../mo2Codecs/modlistText';

/** `modbench.mod.move` over mods (mods.md, Pickers, Move): they land as one block, in their own
 *  order, at the `end` of the place. A separator or mod that has gone refuses the whole move. */
export function moveMods(
  instanceRoot: string, profile: string, modNames: readonly string[], place: MovePlace, end: OrderEnd,
): Promise<ModlistSelectionResult> {
  return spliceSelection(instanceRoot, profile, 'mod', modNames, (text, found) =>
    moveModsInText(text, found, place, end));
}

/** `modbench.mod.move` over separators (mods.md, Pickers, Move): each brings every mod it holds,
 *  and they land on the `end` side of the place. A target that has gone refuses the whole move. */
export function moveSeparators(
  instanceRoot: string, profile: string, separatorNames: readonly string[], place: SeparatorsPlace, end: OrderEnd,
): Promise<ModlistSelectionResult> {
  return spliceSelection(instanceRoot, profile, 'separator', separatorNames, (text, found) =>
    moveSeparatorsInText(text, found, place, end));
}

const SEPARATOR_NAME_CLASH = 'A separator with this name already exists';

/** Why `requested` cannot name a separator among `entries`, or `undefined` when it can. Its name
 *  is the one MO2 would give its folder, and `own` is the name of the separator being renamed. */
export function separatorNameRefusal(
  entries: readonly Pick<ModlistEntry, 'kind' | 'name'>[], requested: string, own?: string,
): string | undefined {
  const name = mo2FolderName(requested);
  if (!name) return `Not a valid separator name: "${requested}"`;
  const clashes = name !== own && entries.some((e) => e.kind === 'separator' && e.name === name);
  return clashes ? SEPARATOR_NAME_CLASH : undefined;
}

function refuseSeparatorName(text: string, requested: string, own?: string): void {
  const refusal = separatorNameRefusal(parseModlist(text), requested, own);
  if (refusal !== undefined) throw new Error(refusal);
}

const folderOfFiltered = (instanceRoot: string, name: string): string =>
  present(separatorDir(instanceRoot, name), `the folder of the filtered separator name "${name}"`);

// A separator gesture writes its line, then makes or renames its folder. Until it is done, mod
// sync leaves the folders it names alone: it neither drops their lines nor adds lines for them.
const foldersInGesture = new Map<string, number>();
const gestureKey = (instanceRoot: string, folder: string): string => modDir(instanceRoot, modNameKey(folder));

async function whileInGesture<T>(
  instanceRoot: string, folders: readonly (string | undefined)[], gesture: () => Promise<T>,
): Promise<T> {
  const held = folders.filter((f): f is string => f !== undefined).map((f) => gestureKey(instanceRoot, f));
  for (const f of held) foldersInGesture.set(f, (foldersInGesture.get(f) ?? 0) + 1);
  try {
    return await gesture();
  } finally {
    for (const f of held) {
      const left = (foldersInGesture.get(f) ?? 1) - 1;
      if (left === 0) foldersInGesture.delete(f);
      else foldersInGesture.set(f, left);
    }
  }
}

/** Insert a new enabled separator next to the anchor (mods.md, Add separator): on a mod, directly
 *  after it; on a separator, before its own group's winning-most member. */
export async function insertSeparator(
  instanceRoot: string, profile: string, requested: string, anchor: Pick<ModlistEntry, 'kind' | 'name'>,
): Promise<ModlistCommandResult> {
  const name = mo2FolderName(requested);
  return whileInGesture(instanceRoot, [separatorFolderName(name)], () =>
    insertSeparatorLineThenFolder(instanceRoot, profile, requested, name, anchor));
}

async function insertSeparatorLineThenFolder(
  instanceRoot: string, profile: string, requested: string, name: string, anchor: Pick<ModlistEntry, 'kind' | 'name'>,
): Promise<ModlistCommandResult> {
  const line = await spliceModlist(instanceRoot, profile, (text) => {
    refuseSeparatorName(text, requested);
    const entries = parseModlist(text);
    const entryIdx = entries.findIndex((e) => e.kind === anchor.kind && e.name === anchor.name);
    if (entryIdx === -1) throw new Error(`Entry not found in modlist: ${anchor.name}`);
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
  return thenFolder(instanceRoot, profile, line, () => ensureDir(folderOfFiltered(instanceRoot, name)),
    (text) => deleteSeparatorInText(text, name));
}

// A name is judged against modlist.txt as it is at write time (mods.md, Add separator), so the
// line is written before the folder, and a folder that then fails takes its line back.
async function thenFolder(
  instanceRoot: string, profile: string, line: ModlistCommandResult,
  folder: () => Promise<void>, undoLine: (text: string) => string,
): Promise<ModlistCommandResult> {
  if (!line.applied) return line;
  try {
    await folder();
    return line;
  } catch (err) {
    const undone = await spliceModlist(instanceRoot, profile, undoLine);
    const reason = errorMessage(err);
    return { applied: false, refusal: undone.applied ? reason : `${reason}; its modlist.txt line could not be put back: ${undone.refusal}` };
  }
}

/** Rename a separator in place, and its folder with it. */
export async function renameSeparator(
  instanceRoot: string, profile: string, oldName: string, requested: string,
): Promise<ModlistCommandResult> {
  const newName = mo2FolderName(requested);
  const oldFolder = separatorDir(instanceRoot, oldName);
  return whileInGesture(instanceRoot, [separatorFolderName(oldName), separatorFolderName(newName)], async () => {
    const line = await spliceModlist(instanceRoot, profile, (text) => {
      refuseSeparatorName(text, requested, oldName);
      return renameSeparatorInText(text, oldName, newName);
    });
    return thenFolder(instanceRoot, profile, line, async () => {
      if (oldFolder !== undefined && await exists(oldFolder)) {
        await rename(oldFolder, folderOfFiltered(instanceRoot, newName));
      }
    }, (text) => renameSeparatorInText(text, newName, oldName));
  });
}

const entryNamesIn = (text: string, kind: EntryKind): ReadonlySet<string> =>
  new Set(parseModlist(text).filter((e) => e.kind === kind).map((e) => e.name));

/** A landed entry. `lineRefusal` is set when its folder reached the trash but its line then
 *  could not go — the part that failed, not a refusal (common.md, Reporting). */
export interface TrashedEntry {
  name: string;
  lineRefusal?: string;
}

type TrashThenUnlistResult =
  | { applied: true; outcome: SelectionOutcome<TrashedEntry> }
  | { applied: false; refusal: string };

// `deleteSeparators` and `uninstallMods` share this shape: trash each entry's folder before its
// line. An entry never trashed refuses outright on a line failure; a trashed one still lands,
// carrying the failure rather than folding it into a refusal.
async function trashThenUnlist(
  instanceRoot: string, profile: string, kind: EntryKind, names: readonly string[],
  folderOf: (name: string) => string | undefined, trash: MoveToTrash,
  removeLine: (text: string, name: string) => string,
): Promise<TrashThenUnlistResult> {
  const noun = kind === 'mod' ? 'Mod' : 'Separator';
  let listed: ReadonlySet<string>;
  try {
    listed = entryNamesIn(await get(modlistFile(instanceRoot, profile)), kind);
  } catch (err) {
    return refuse(err);
  }
  const refused: ItemRefusal<TrashedEntry>[] = names.filter((name) => !listed.has(name))
    .map((name) => ({ item: { name }, reason: `${noun} not found in modlist: ${name}` }));
  const toUnlist: string[] = [];
  const trashed = new Set<string>();
  for (const name of names.filter((n) => listed.has(n))) {
    const folder = folderOf(name);
    try {
      if (folder !== undefined && await exists(folder)) {
        await trash(folder);
        trashed.add(name);
      }
      toUnlist.push(name);
    } catch (err) {
      refused.push({ item: { name }, reason: errorMessage(err) });
    }
  }
  const lines = await spliceModlist(instanceRoot, profile, (text) => {
    const stillListed = entryNamesIn(text, kind);
    return toUnlist.filter((name) => stillListed.has(name)).reduce((acc, name) => removeLine(acc, name), text);
  });
  if (lines.applied) return { applied: true, outcome: { landed: toUnlist.map((name) => ({ name })), refused } };
  return {
    applied: true,
    outcome: {
      landed: toUnlist.filter((name) => trashed.has(name)).map((name) => ({ name, lineRefusal: lines.refusal })),
      refused: [
        ...refused,
        ...toUnlist.filter((name) => !trashed.has(name)).map((name) => ({ item: { name }, reason: lines.refusal })),
      ],
    },
  };
}

export type DeleteSeparatorsResult = TrashThenUnlistResult;

/** `modbench.separator.delete` over the selection. The trash cannot be undone, so each folder goes
 *  before its line: a refused trash writes nothing for that separator (update-load-order-file,
 *  Refusals). */
export function deleteSeparators(
  instanceRoot: string, profile: string, names: readonly string[], trash: MoveToTrash,
): Promise<DeleteSeparatorsResult> {
  return trashThenUnlist(
    instanceRoot, profile, 'separator', names,
    (name) => separatorDir(instanceRoot, name), trash,
    (text, name) => deleteSeparatorInText(text, name),
  );
}

// A mod outlives its download, so an archive that is gone is left alone: a sidecar beside no
// archive is one MO2 never writes. `installed` stays, as MO2 leaves it — the codec resolves the
// keys' precedence.
async function unmarkDownload(downloadsDir: string, name: string): Promise<void> {
  if (!(await exists(downloadFile(downloadsDir, name)))) return;
  await put(downloadSidecarFile(downloadsDir, name), setUninstalledInText, { ifMissing: '' });
}

/** A mod handed to `uninstallMods`: its own name, and the downloaded file it was installed from,
 *  when known. With none, no download is marked. */
export interface ModToUninstall {
  name: string;
  archiveFilename?: string;
}

/** A landed mod. `markRefusal` is set when its `.meta` could not be marked uninstalled — the
 *  uninstall still stands. Never set alongside `lineRefusal`: a line not truly gone marks nothing. */
export interface UninstalledMod extends TrashedEntry {
  markRefusal?: string;
}

export type UninstallModsResult =
  | { applied: true; outcome: SelectionOutcome<UninstalledMod> }
  | { applied: false; refusal: string };

/** `modbench.mod.uninstall` over the selection: each mod's folder to the trash, then its line,
 *  then its downloaded file marked (update-load-order-file, mod `uninstall`). `downloadsDir`
 *  undefined (unresolved) skips the mark; its reason was already logged once. */
export async function uninstallMods(
  instanceRoot: string, profile: string, mods: readonly ModToUninstall[], downloadsDir: string | undefined,
  trash: MoveToTrash,
): Promise<UninstallModsResult> {
  const archiveOf = new Map(mods.map((m) => [m.name, m.archiveFilename] as const));
  const result = await trashThenUnlist(
    instanceRoot, profile, 'mod', mods.map((m) => m.name),
    (name) => modDir(instanceRoot, name), trash,
    (text, name) => removeModFromText(text, name),
  );
  if (!result.applied) return result;
  const landed: UninstalledMod[] = [];
  for (const entry of result.outcome.landed) {
    // The line is not truly gone, so its download is left for a later, clean uninstall to mark.
    if (entry.lineRefusal !== undefined) {
      landed.push(entry);
      continue;
    }
    const archiveFilename = archiveOf.get(entry.name);
    if (archiveFilename === undefined || downloadsDir === undefined) {
      landed.push({ name: entry.name });
      continue;
    }
    try {
      await unmarkDownload(downloadsDir, archiveFilename);
      landed.push({ name: entry.name });
    } catch (err) {
      landed.push({ name: entry.name, markRefusal: errorMessage(err) });
    }
  }
  return { applied: true, outcome: { landed, refused: result.outcome.refused } };
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

// What a line carries after its prefix: a mod's name, or a separator's `<name>_separator`.
const lineNameOf = (entry: ModlistEntry): string =>
  (entry.kind === 'mod' ? entry.name : separatorModName(entry.name));

// A separator whose name MO2 never gives a folder names none: MO2 has no mod by that name, so its
// line goes (ADR-0017), and no path is built from it.
const listedFolderOf = (entry: ModlistEntry): string | undefined =>
  (entry.kind === 'mod' ? entry.name : separatorFolderName(entry.name));

async function keepWhere<T>(items: readonly T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept = await Promise.all(items.map(keep));
  return items.filter((_, i) => kept[i]);
}

/** `modbench.mod.sync`: a disabled line for each folder with none, and each line whose folder is
 *  gone dropped, in one write; `dropped` names those lines. No `mods/` to list is refused. */
export async function syncMods(
  instanceRoot: string, profile: string, modFolders: readonly string[] | undefined,
): Promise<ModSyncResult> {
  if (modFolders === undefined) {
    return { applied: false, refusal: `${modsDir(instanceRoot)} does not exist` };
  }
  const listed = new Set(modFolders.map(modNameKey));
  const inGesture = (folder: string) => foldersInGesture.has(gestureKey(instanceRoot, folder));
  const onDisk = (folder: string) => exists(modDir(instanceRoot, folder));
  let added: string[] = [];
  let dropped: string[] = [];
  const outcome = await spliceModlist(instanceRoot, profile, async (text) => {
    // Under the write lock: two values can hand over the same folders before the first write comes
    // back, and each lags the disk, so only the text about to be spliced and the disk as it is now
    // say what is still to do.
    const entries = parseModlist(text);
    const gone = await keepWhere(entries, async (entry) => {
      const folder = listedFolderOf(entry);
      if (folder === undefined) return true;
      return !listed.has(modNameKey(folder)) && !inGesture(folder) && !(await onDisk(folder));
    });
    added = await keepWhere(unlistedModNames([...modFolders], entries),
      async (folder) => !inGesture(folder) && onDisk(folder));
    dropped = gone.map(lineNameOf);
    // insertModAtWinningEnd always lands its new line above whatever is currently first, so
    // inserting in reverse order leaves the batch ascending top-to-bottom on disk.
    const withoutGone = gone.reduce((out, entry) => (entry.kind === 'separator'
      ? deleteSeparatorInText(out, entry.name)
      : removeModFromText(out, entry.name)), text);
    return [...added].reverse().reduce((out, name) => insertModAtWinningEnd(out, name), withoutGone);
  });
  return outcome.applied ? { applied: true, added, dropped } : outcome;
}
