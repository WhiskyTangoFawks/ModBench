import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import {
  entryNotFound, goneFromDisk, newModNameRefusal, type DecideModOrder, type EntryRef, type FileOrigin, type InstanceAdapter,
  type ModFolder, type ModlistEntry, type ModOrderChange, type MovePlace, type OrderEnd, type OriginFileMark, type SeparatorsPlace,
} from '../instanceAdapter/instanceAdapter';

/** What a modlist command reaches the instance through. */
export interface ModlistAccess {
  readonly adapter: InstanceAdapter;
}

/** `wrote` is false when the gesture was already true of mod order. */
export type ModlistCommandResult =
  | { applied: true; wrote: boolean }
  | { applied: false; refusal: string };

async function changeModOrder(access: ModlistAccess, profile: string, decide: DecideModOrder): Promise<ModlistCommandResult> {
  try {
    const { wrote } = await access.adapter.changeModOrder(profile, decide);
    return { applied: true, wrote };
  } catch (err) {
    return refuse(err);
  }
}

/** A gesture over a selection, in one write: each item landed or refused by name, or the whole
 *  selection refused once when mod order cannot be read or written. */
export type ModlistSelectionResult =
  | { applied: true; outcome: SelectionOutcome<string> }
  | { applied: false; refusal: string };

type EntryKind = EntryRef['kind'];

// A command names an entry by the name the value listed it under.
const isListed = (order: readonly ModlistEntry[], entry: EntryRef): boolean =>
  order.some((e) => e.kind === entry.kind && e.name === entry.name);

// Decided from mod order as it stands when the changes land, so an item gone since the view last
// rendered is refused by name while the rest land in the same write.
async function changeSelection(
  access: ModlistAccess, profile: string, kind: EntryKind, names: readonly string[],
  changesFor: (found: readonly string[]) => readonly ModOrderChange[],
): Promise<ModlistSelectionResult> {
  let outcome: SelectionOutcome<string> = { landed: [], refused: [] };
  const result = await changeModOrder(access, profile, (order) => {
    const landed = names.filter((name) => isListed(order, { kind, name }));
    const refused = names.filter((name) => !landed.includes(name)).map((name) => ({ item: name, reason: entryNotFound({ kind, name }) }));
    outcome = { landed, refused };
    return changesFor(landed);
  });
  return result.applied ? { applied: true, outcome } : result;
}

/** `modbench.mod.enable` / `modbench.mod.disable`, over the whole selection in one write. */
export function setModsEnabled(
  access: ModlistAccess, profile: string, modNames: readonly string[], enabled: boolean,
): Promise<ModlistSelectionResult> {
  return changeSelection(access, profile, 'mod', modNames, (found) =>
    found.map((mod) => ({ kind: 'enable', mod, enabled })));
}

export type { MovePlace, OrderEnd, OriginFileMark, SeparatorsPlace } from '../instanceAdapter/instanceAdapter';

/** `modbench.mod.move` over mods (mods.md, Pickers, Move): they land as one block, in their own
 *  order, at the `end` of the place. A separator or mod that has gone refuses the whole move. */
export function moveMods(
  access: ModlistAccess, profile: string, modNames: readonly string[], place: MovePlace, end: OrderEnd,
): Promise<ModlistSelectionResult> {
  return changeSelection(access, profile, 'mod', modNames, (found) => [{ kind: 'moveMods', mods: found, place, end }]);
}

/** `modbench.mod.move` over separators (mods.md, Pickers, Move): each brings every mod it holds,
 *  and they land on the `end` side of the place. A target that has gone refuses the whole move. */
export function moveSeparators(
  access: ModlistAccess, profile: string, separatorNames: readonly string[], place: SeparatorsPlace, end: OrderEnd,
): Promise<ModlistSelectionResult> {
  return changeSelection(access, profile, 'separator', separatorNames, (found) =>
    [{ kind: 'moveSeparators', separators: found, place, end }]);
}

/** A file of a mod or Overwrite, by its path in it. */
export interface OriginFileRef {
  readonly origin: FileOrigin;
  readonly relativePath: string;
}

/** `modbench.mod.excludeFile` / `modbench.mod.includeFile`: each file marked on its own. */
export async function markFiles(
  access: ModlistAccess, files: readonly OriginFileRef[], mark: OriginFileMark,
): Promise<SelectionOutcome<OriginFileRef>> {
  const landed: OriginFileRef[] = [];
  const refused: ItemRefusal<OriginFileRef>[] = [];
  for (const file of files) {
    try {
      const marked = await access.adapter.markOriginFile(file.origin, file.relativePath, mark);
      if (marked.gone) refused.push({ item: file, reason: goneFromDisk(file.relativePath) });
      else if ('refusal' in marked) refused.push({ item: file, reason: marked.refusal });
      else landed.push(file);
    } catch (err) {
      refused.push({ item: file, reason: errorMessage(err) });
    }
  }
  return { landed, refused };
}

const SEPARATOR_NAME_CLASH = 'A separator with this name already exists';

/** Why `requested` cannot name a separator, or `undefined` when it can: the profile's mod order
 *  lists one of that name, or a folder holds one, matched as the instance matches names. `own`, the
 *  separator being renamed, is no clash. */
export async function separatorNameRefusal(
  access: ModlistAccess, profile: string, requested: string, own?: string,
): Promise<string | undefined> {
  const listed = await access.adapter.orderEntry(profile, { kind: 'separator', name: requested });
  if (listed !== undefined && listed.name !== own) return SEPARATOR_NAME_CLASH;
  const holding = await access.adapter.entryFolder({ kind: 'separator', name: requested });
  if (holding === undefined) return undefined;
  const ownFolder = own === undefined ? undefined : await access.adapter.entryFolder({ kind: 'separator', name: own });
  return ownFolder?.path === holding.path ? undefined : SEPARATOR_NAME_CLASH;
}

// The first index of the run of mods directly on the winning side of the separator at `at`.
function groupStartOf(order: readonly ModlistEntry[], at: number): number {
  let start = at;
  while (start > 0 && order[start - 1]?.kind === 'mod') start--;
  return start;
}

/** Insert a new enabled separator next to the anchor (mods.md, Add separator): on a mod, directly
 *  after it; on a separator, before its own group's winning-most member. */
export function insertSeparator(
  access: ModlistAccess, profile: string, requested: string, anchor: EntryRef,
): Promise<ModlistCommandResult> {
  return changeModOrder(access, profile, (order) => {
    const at = order.findIndex((e) => e.kind === anchor.kind && e.name === anchor.name);
    if (at === -1) throw new Error(`Entry not found in modlist: ${anchor.name}`);
    const afterIndex = anchor.kind === 'separator' ? groupStartOf(order, at) - 1 : at;
    return [{ kind: 'addSeparator', separator: requested, afterIndex }];
  });
}

/** Rename a separator in place, and its folder with it. */
export function renameSeparator(
  access: ModlistAccess, profile: string, oldName: string, requested: string,
): Promise<ModlistCommandResult> {
  return changeModOrder(access, profile, () => [{ kind: 'renameSeparator', from: oldName, to: requested }]);
}

/** A landed entry. `lineRefusal` is set when its folder reached the trash but its line then
 *  could not go — the part that failed, not a refusal (common.md, Reporting). */
export interface TrashedEntry {
  name: string;
  lineRefusal?: string;
}

type TrashThenUnlistResult =
  | { applied: true; outcome: SelectionOutcome<TrashedEntry> }
  | { applied: false; refusal: string };

const dropOf = (entry: EntryRef): ModOrderChange =>
  (entry.kind === 'mod' ? { kind: 'dropMod', mod: entry.name } : { kind: 'dropSeparator', separator: entry.name });

// `deleteSeparators` and `uninstallMods` share this shape: trash each entry's folder before its
// line. An entry never trashed refuses outright on a line failure; a trashed one still lands,
// carrying the failure rather than folding it into a refusal.
async function trashThenUnlist(
  access: ModlistAccess, profile: string, kind: EntryKind, names: readonly string[], trash: MoveToTrash,
): Promise<TrashThenUnlistResult> {
  let order: readonly ModlistEntry[];
  try {
    order = await access.adapter.modOrder(profile);
  } catch (err) {
    return refuse(err);
  }
  const refused: ItemRefusal<TrashedEntry>[] = names.filter((name) => !isListed(order, { kind, name }))
    .map((name) => ({ item: { name }, reason: entryNotFound({ kind, name }) }));
  const toUnlist: string[] = [];
  const trashed = new Set<string>();
  for (const name of names.filter((n) => isListed(order, { kind, name: n }))) {
    try {
      if (await access.adapter.trashEntryFolder({ kind, name }, trash)) trashed.add(name);
      toUnlist.push(name);
    } catch (err) {
      refused.push({ item: { name }, reason: errorMessage(err) });
    }
  }
  const lines = await changeModOrder(access, profile, () => toUnlist.map((name) => dropOf({ kind, name })));
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
 *  before its line: a refused trash writes nothing for that separator (commands.md, *A failed
 *  gesture writes nothing*). */
export function deleteSeparators(
  access: ModlistAccess, profile: string, names: readonly string[], trash: MoveToTrash,
): Promise<DeleteSeparatorsResult> {
  return trashThenUnlist(access, profile, 'separator', names, trash);
}

/** A mod handed to `uninstallMods`: its own name, and the downloaded file it was installed from,
 *  when known. With none, no download is marked. */
export interface ModToUninstall {
  name: string;
  archiveFilename?: string;
}

/** A landed mod. `markRefusal` is set when its downloaded file could not be marked uninstalled,
 *  and the uninstall still stands. A line not truly gone marks nothing, so never beside
 *  `lineRefusal`. */
export interface UninstalledMod extends TrashedEntry {
  markRefusal?: string;
}

export type UninstallModsResult =
  | { applied: true; outcome: SelectionOutcome<UninstalledMod> }
  | { applied: false; refusal: string };

/** `modbench.mod.uninstall` over the selection: each mod's folder to the trash, then its line,
 *  then its downloaded file marked unless that file is gone (mods.md, Reporting, story 4). */
export async function uninstallMods(
  access: ModlistAccess, profile: string, mods: readonly ModToUninstall[], trash: MoveToTrash,
): Promise<UninstallModsResult> {
  const archiveOf = new Map(mods.map((m) => [m.name, m.archiveFilename] as const));
  const result = await trashThenUnlist(access, profile, 'mod', mods.map((m) => m.name), trash);
  if (!result.applied) return result;
  const landed: UninstalledMod[] = [];
  for (const entry of result.outcome.landed) {
    const archiveFilename = archiveOf.get(entry.name);
    if (entry.lineRefusal !== undefined || archiveFilename === undefined) {
      landed.push(entry);
      continue;
    }
    try {
      await access.adapter.markDownloadedFile(archiveFilename, 'Uninstalled');
      landed.push(entry);
    } catch (err) {
      landed.push({ ...entry, markRefusal: errorMessage(err) });
    }
  }
  return { applied: true, outcome: { landed, refused: result.outcome.refused } };
}

/** `lineRefusal` is set only when the folder landed and the line did not: the folder stays, and
 *  `mod sync` adopts it next (common.md, Reporting: "A gesture landed, but part of it failed"). */
export type CreateEmptyModResult =
  | { applied: true; wrote: boolean; lineRefusal?: string }
  | { applied: false; refusal: string };

/** A mod's folder plus a disabled line at the winning end of mod order — nothing else. A name a
 *  folder already holds is refused. */
export async function createEmptyMod(access: ModlistAccess, profile: string, name: string): Promise<CreateEmptyModResult> {
  try {
    const refusal = await newModNameRefusal(access.adapter, name);
    if (refusal !== undefined) return { applied: false, refusal };
    await access.adapter.createModFolder(name);
  } catch (err) {
    return refuse(err);
  }
  const line = await changeModOrder(access, profile, () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);
  if (!line.applied) return { applied: true, wrote: false, lineRefusal: line.refusal };
  return line;
}

export type ModSyncResult =
  | { applied: true; added: string[]; dropped: string[] }
  | { applied: false; refusal: string };

const NO_MOD_FOLDERS = 'there is no folder for mods';

const describeEntry = (entry: EntryRef): string => (entry.kind === 'mod' ? entry.name : `${entry.name} (separator)`);

/** `modbench.mod.sync`, in one write checked against the folders as they stand when it lands: a
 *  disabled line for each of `modFolders` with none, and each line no folder holds dropped.
 *  `added` and `dropped` describe those entries. */
export async function syncMods(access: ModlistAccess, profile: string, modFolders: readonly ModFolder[]): Promise<ModSyncResult> {
  const toSync = new Set(modFolders.map((folder) => folder.path));
  let added: string[] = [];
  let dropped: string[] = [];
  const outcome = await changeModOrder(access, profile, (order, folders) => {
    if (folders === undefined) throw new Error(NO_MOD_FOLDERS);
    const gone = order.filter((entry) => folders.holding(entry) === undefined);
    const held = new Set(order.flatMap((entry) => folders.holding(entry)?.path ?? []));
    const unlisted = folders.all.filter((folder) => toSync.has(folder.path) && !held.has(folder.path))
      .sort((a, b) => a.name.localeCompare(b.name));
    added = unlisted.map(describeEntry);
    dropped = gone.map(describeEntry);
    // Each line added lands above the one before it, so adding in reverse leaves the batch in
    // order from the winning end.
    return [
      ...gone.map(dropOf),
      ...[...unlisted].reverse().map((folder): ModOrderChange => ({ kind: 'addAtWinningEnd', entry: { kind: folder.kind, name: folder.name } })),
    ];
  });
  return outcome.applied ? { applied: true, added, dropped } : outcome;
}

/** Mod sync on a landed value's own profile and mod folders. */
export type ModSyncRun = (value: { readonly activeProfile: string; readonly modFolders: readonly ModFolder[] | undefined }) => Promise<ModSyncResult>;

/** `syncMods` bound to one instance. */
export function modSyncOver(access: ModlistAccess): ModSyncRun {
  return (value) => syncMods(access, value.activeProfile, value.modFolders ?? []);
}
