import { refuse } from '../ports/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import {
  entryNotFound, sameEntry, type DecideModOrder, type EntryRef, type FileOrigin, type InstanceAdapter,
  type ModlistEntry, type ModOrderChange, type MovePlace, type OrderEnd, type OriginFileMark, type SeparatorsPlace,
} from '../instanceAdapter/instanceAdapter';
import { EMPTY_MOD_NAME, entryNameRefusal, goneFromDisk, newModNameRefusal, type EntryKey, type TakenNames } from '../coreLib/commandRefusals';
import type { TailOf } from '../coreLib/boundCommand';
import { selectionOutcomeOf, type CommandResult, type SelectionResult } from '../coreLib/commandResult';
import { isRefused, type MEditClient, type ReadModStatus } from '../client';
import { installMod } from './install';
export type { SelectionResult };
export type { InstallTarget } from '../instanceAdapter/instanceAdapter';
export type { ModPackage } from './install';

async function changeModOrderLanding(
  adapter: InstanceAdapter, profile: string, decide: DecideModOrder,
): Promise<CommandResult<Awaited<ReturnType<InstanceAdapter['changeModOrder']>>>> {
  try {
    return { applied: true, ...await adapter.changeModOrder(profile, decide) };
  } catch (err) {
    return refuse(err);
  }
}

async function changeModOrder(adapter: InstanceAdapter, profile: string, decide: DecideModOrder): Promise<CommandResult> {
  const result = await changeModOrderLanding(adapter, profile, decide);
  return result.applied ? { applied: true, wrote: result.wrote } : result;
}

// A separator written, and the name it was written under.
type SeparatorResult = CommandResult<{ wrote: boolean; name: string }>;

async function changeSeparator(adapter: InstanceAdapter, profile: string, decide: DecideModOrder): Promise<SeparatorResult> {
  const result = await changeModOrderLanding(adapter, profile, decide);
  if (!result.applied) return result;
  const name = result.landed.flatMap((change) => (change.kind === 'addSeparator' ? [change.separator] : change.kind === 'renameSeparator' ? [change.to] : []))[0];
  if (name === undefined) throw new Error('The adapter landed no separator.');
  return { applied: true, wrote: result.wrote, name };
}

type EntryKind = EntryRef['kind'];

// A command names an entry as the mod manager matches names.
const isListed = (adapter: InstanceAdapter, order: readonly ModlistEntry[], entry: EntryRef): boolean =>
  order.some((e) => sameEntry(adapter, e, entry));

// Decided from mod order as it stands when the changes land, so an item gone since the view last
// rendered is refused by name while the rest land in the same write.
async function changeSelection(
  adapter: InstanceAdapter, profile: string, kind: EntryKind, names: readonly string[],
  changesFor: (found: readonly string[]) => readonly ModOrderChange[],
): Promise<SelectionResult<string>> {
  let outcome: SelectionOutcome<string> = { landed: [], refused: [] };
  const result = await changeModOrder(adapter, profile, (order) => {
    const landed = names.filter((name) => isListed(adapter, order, { kind, name }));
    const refused = names.filter((name) => !landed.includes(name)).map((name) => ({ item: name, reason: entryNotFound({ kind, name }) }));
    outcome = { landed, refused };
    return changesFor(landed);
  });
  return result.applied ? { applied: true, outcome } : result;
}

// `modbench.mod.enable` / `modbench.mod.disable`, over the whole selection in one write.
function setModsEnabled(
  adapter: InstanceAdapter, profile: string, modNames: readonly string[], enabled: boolean,
): Promise<SelectionResult<string>> {
  return changeSelection(adapter, profile, 'mod', modNames, (found) =>
    found.map((mod) => ({ kind: 'enable', mod, enabled })));
}

export type { EntryRef, MovePlace, OrderEnd, OriginFileMark, SeparatorsPlace } from '../instanceAdapter/instanceAdapter';

// `modbench.mod.move` over mods (mods.md, Pickers, Move): they land as one block, in their own
// order, at the `end` of the place. A separator or mod that has gone refuses the whole move.
function moveMods(
  adapter: InstanceAdapter, profile: string, modNames: readonly string[], place: MovePlace, end: OrderEnd,
): Promise<SelectionResult<string>> {
  return changeSelection(adapter, profile, 'mod', modNames, (found) => [{ kind: 'moveMods', mods: found, place, end }]);
}

// `modbench.mod.move` over separators (mods.md, Pickers, Move): each brings every mod it holds,
// and they land on the `end` side of the place. A target that has gone refuses the whole move.
function moveSeparators(
  adapter: InstanceAdapter, profile: string, separatorNames: readonly string[], place: SeparatorsPlace, end: OrderEnd,
): Promise<SelectionResult<string>> {
  return changeSelection(adapter, profile, 'separator', separatorNames, (found) =>
    [{ kind: 'moveSeparators', separators: found, place, end }]);
}

/** A file of a mod or Overwrite, by its path in it. */
export interface OriginFileRef {
  readonly origin: FileOrigin;
  readonly relativePath: string;
}

interface SourceModWriters {
  readonly adapter: InstanceAdapter;
  readonly mEdit: Pick<MEditClient, 'changeBuildConfiguration'>;
}

const UNMARK: Record<OriginFileMark, OriginFileMark> = { Excluded: 'Included', Included: 'Excluded' };

const exclusionChange = (mark: OriginFileMark, paths: string[]) => (mark === 'Excluded' ? { exclude: paths } : { include: paths });

function markEach(adapter: InstanceAdapter, files: readonly OriginFileRef[], mark: OriginFileMark): Promise<SelectionOutcome<OriginFileRef>> {
  return selectionOutcomeOf(files, async (file): Promise<CommandResult> => {
    try {
      const marked = await adapter.markOriginFile(file.origin, file.relativePath, mark);
      if (marked.gone) return { applied: false, refusal: goneFromDisk(file.relativePath) };
      if ('refusal' in marked) return { applied: false, refusal: marked.refusal };
      return { applied: true, wrote: true };
    } catch (err) {
      return refuse(err);
    }
  }, (file) => file);
}

type SourceGroups = ReadonlyMap<string | undefined, readonly OriginFileRef[]>;

function bySourceFolder(files: readonly OriginFileRef[], sourceFolders: ReadonlyMap<string, string>): SourceGroups {
  const groups = new Map<string | undefined, OriginFileRef[]>();
  for (const file of files) {
    const sourceFolder = file.origin.kind === 'mod' ? sourceFolders.get(file.origin.name) : undefined;
    groups.set(sourceFolder, [...(groups.get(sourceFolder) ?? []), file]);
  }
  return groups;
}

type ExclusionChange = (sourceFolder: string, files: readonly OriginFileRef[], to: OriginFileMark) => ReturnType<MEditClient['changeBuildConfiguration']>;

// Each source mod's refusal by its source folder; or, when mEdit cannot be reached, the whole selection's, with the
// configurations already changed put back.
async function configureEach(
  change: ExclusionChange, groups: SourceGroups, mark: OriginFileMark,
): Promise<{ refusals: ReadonlyMap<string, string> } | { unreachable: string }> {
  const refusals = new Map<string, string>();
  const configured: [string, readonly OriginFileRef[]][] = [];
  for (const [sourceFolder, files] of groups) {
    if (sourceFolder === undefined) continue;
    const answer = await change(sourceFolder, files, mark);
    if (isRefused(answer) && answer.unreachable) {
      const notPutBack = await Promise.all(configured.map(async ([folder, of]) => {
        const putBack = await change(folder, of, UNMARK[mark]);
        return isRefused(putBack) ? [` The build configuration in "${folder}" could not be put back: ${putBack.message}`] : [];
      }));
      return { unreachable: [answer.message, ...notPutBack.flat()].join('') };
    }
    if (isRefused(answer)) refusals.set(sourceFolder, answer.message);
    else configured.push([sourceFolder, files]);
  }
  return { refusals };
}

// A file of a configured source mod that could not be marked has its change to the configuration taken back.
async function markInSourceMod(
  adapter: InstanceAdapter, change: ExclusionChange, sourceFolder: string, files: readonly OriginFileRef[], mark: OriginFileMark,
): Promise<SelectionOutcome<OriginFileRef>> {
  const outcome = await markEach(adapter, files, mark);
  if (outcome.refused.length === 0) return outcome;
  const takenBack = await change(sourceFolder, outcome.refused.map(({ item }) => item), UNMARK[mark]);
  if (!isRefused(takenBack)) return outcome;
  return {
    landed: outcome.landed,
    refused: outcome.refused.map(({ item, reason }) => ({
      item, reason: `${reason} Its change to the build configuration could not be taken back: ${takenBack.message}`,
    })),
  };
}

// `modbench.mod.excludeFile` / `modbench.mod.includeFile`: each file marked on its own, a source mod's build
// configuration first, so a refusal all its files share writes none of them (commands.md, A selection is one gesture).
async function markFiles(
  { adapter, mEdit }: SourceModWriters, files: readonly OriginFileRef[], mark: OriginFileMark, sourceFolders: ReadonlyMap<string, string>,
): Promise<SelectionResult<OriginFileRef>> {
  const change: ExclusionChange = (sourceFolder, of, to) =>
    mEdit.changeBuildConfiguration(sourceFolder, exclusionChange(to, of.map((file) => adapter.includedPath(file.relativePath))));
  const groups = bySourceFolder(files, sourceFolders);
  const configured = await configureEach(change, groups, mark);
  if ('unreachable' in configured) return { applied: false, refusal: configured.unreachable };
  const landed: OriginFileRef[] = [];
  const refused: ItemRefusal<OriginFileRef>[] = [];
  for (const [sourceFolder, inIt] of groups) {
    const refusal = sourceFolder === undefined ? undefined : configured.refusals.get(sourceFolder);
    const outcome = sourceFolder === undefined ? await markEach(adapter, inIt, mark)
      : refusal === undefined ? await markInSourceMod(adapter, change, sourceFolder, inIt, mark)
        : { landed: [], refused: inIt.map((item) => ({ item, reason: refusal })) };
    landed.push(...outcome.landed);
    refused.push(...outcome.refused);
  }
  return { applied: true, outcome: { landed, refused } };
}

const SEPARATOR_NAME_CLASH = 'A separator with this name already exists';
const MOD_NAME_CLASH = 'A mod with this name already exists';
const MOD_NAME_WITH_PATH_SEPARATOR = 'A mod name cannot contain / or \\';

// Why `requested` cannot name a separator, or `undefined` when it can: a separator of that name is
// listed or has a folder, compared without case. `own`, the separator being renamed, is no clash.
const separatorNameRefusal = (key: EntryKey, taken: TakenNames, requested: string, own?: string): string | undefined =>
  entryNameRefusal(key, taken, 'separator', requested, SEPARATOR_NAME_CLASH, own);

// Why `requested` cannot rename mod `own`, or `undefined` when it can: it holds a path separator, or
// another mod of that name is listed or has a folder, compared without case.
const renameModNameRefusal = (key: EntryKey, taken: TakenNames, requested: string, own: string): string | undefined =>
  (/[\\/]/.test(requested) ? MOD_NAME_WITH_PATH_SEPARATOR : entryNameRefusal(key, taken, 'mod', requested, MOD_NAME_CLASH, own));

// Insert a new enabled separator next to the anchor (mods.md, Add separator); the adapter places it.
function insertSeparator(
  adapter: InstanceAdapter, profile: string, requested: string, anchor: EntryRef,
): Promise<SeparatorResult> {
  return changeSeparator(adapter, profile, () => [{ kind: 'addSeparator', separator: requested, anchor }]);
}

// Rename a separator in place, and its folder with it.
function renameSeparator(
  adapter: InstanceAdapter, profile: string, oldName: string, requested: string,
): Promise<SeparatorResult> {
  return changeSeparator(adapter, profile, () => [{ kind: 'renameSeparator', from: oldName, to: requested }]);
}

interface TrashedEntry {
  name: string;
  lineRefusal?: string;
  sourceRefusal?: string;
}

const dropOf = (entry: EntryRef): ModOrderChange =>
  (entry.kind === 'mod' ? { kind: 'dropMod', mod: entry.name } : { kind: 'dropSeparator', separator: entry.name });

// `deleteSeparators` and `uninstallMods` share this shape: trash each entry's folder before its
// line. An entry never trashed refuses outright on a line failure; a trashed one still lands,
// carrying the failure rather than folding it into a refusal.
async function trashThenUnlist(
  adapter: InstanceAdapter, profile: string, order: readonly ModlistEntry[], kind: EntryKind, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionResult<TrashedEntry>> {
  const refused: ItemRefusal<TrashedEntry>[] = names.filter((name) => !isListed(adapter, order, { kind, name }))
    .map((name) => ({ item: { name }, reason: entryNotFound({ kind, name }) }));
  const toUnlist: string[] = [];
  const trashed = new Set<string>();
  const sourceRefusals = new Map<string, string>();
  for (const name of names.filter((n) => isListed(adapter, order, { kind, name: n }))) {
    try {
      if (await adapter.trashEntryFolder({ kind, name }, trash)) trashed.add(name);
      toUnlist.push(name);
    } catch (err) {
      refused.push({ item: { name }, reason: errorMessage(err) });
      continue;
    }
    if (kind === 'mod') {
      try {
        await adapter.trashSourceFolder(name, trash);
      } catch (err) {
        sourceRefusals.set(name, errorMessage(err));
      }
    }
  }
  const lines = await changeModOrder(adapter, profile, () => toUnlist.map((name) => dropOf({ kind, name })));
  const landedEntry = (name: string, lineRefusal?: string): TrashedEntry => ({
    name, ...(lineRefusal !== undefined && { lineRefusal }), ...(sourceRefusals.has(name) && { sourceRefusal: sourceRefusals.get(name) }),
  });
  if (lines.applied) return { applied: true, outcome: { landed: toUnlist.map((name) => landedEntry(name)), refused } };
  return {
    applied: true,
    outcome: {
      landed: toUnlist.filter((name) => trashed.has(name)).map((name) => landedEntry(name, lines.refusal)),
      refused: [
        ...refused,
        ...toUnlist.filter((name) => !trashed.has(name)).map((name) => ({ item: { name }, reason: lines.refusal })),
      ],
    },
  };
}

// `modbench.separator.delete` over the selection. The trash cannot be undone, so each folder goes
// before its line: a refused trash writes nothing for that separator (commands.md, *A failed
// gesture writes nothing*).
function deleteSeparators(
  adapter: InstanceAdapter, profile: string, order: readonly ModlistEntry[], names: readonly string[], trash: MoveToTrash,
): Promise<SelectionResult<TrashedEntry>> {
  return trashThenUnlist(adapter, profile, order, 'separator', names, trash);
}

// A mod handed to `uninstallMods`: its own name, and the downloaded file it was installed from,
// when known. With none, no download is marked.
interface ModToUninstall {
  name: string;
  archiveFilename?: string;
}

// A landed mod. `markRefusal` is set when its downloaded file could not be marked uninstalled,
// and the uninstall still stands. A line not truly gone marks nothing, so never beside
interface UninstalledMod extends TrashedEntry {
  markRefusal?: string;
}

// `modbench.mod.uninstall` over the selection: each mod's folder to the trash, then its line,
// then its downloaded file marked unless that file is gone (mods.md, Reporting, story 4).
async function uninstallMods(
  adapter: InstanceAdapter, profile: string, order: readonly ModlistEntry[], mods: readonly ModToUninstall[], trash: MoveToTrash,
): Promise<SelectionResult<UninstalledMod>> {
  const archiveOf = new Map(mods.map((m) => [m.name, m.archiveFilename] as const));
  const result = await trashThenUnlist(adapter, profile, order, 'mod', mods.map((m) => m.name), trash);
  if (!result.applied) return result;
  const landed: UninstalledMod[] = [];
  for (const entry of result.outcome.landed) {
    const archiveFilename = archiveOf.get(entry.name);
    if (entry.lineRefusal !== undefined || archiveFilename === undefined) {
      landed.push(entry);
      continue;
    }
    try {
      await adapter.markDownloadedFile(archiveFilename, 'Uninstalled');
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

// A mod's folder plus a disabled line at the winning end of mod order — nothing else. A name a
// folder already holds is refused.
async function createEmptyMod(adapter: InstanceAdapter, profile: string, name: string): Promise<CreateEmptyModResult> {
  if (name.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  try {
    await adapter.createModFolder(name);
  } catch (err) {
    return refuse(err);
  }
  const line = await changeModOrder(adapter, profile, () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);
  if (!line.applied) return { applied: true, wrote: false, lineRefusal: line.refusal };
  return line;
}

/** `lineRefusals` names each profile whose line could not be renamed: the folder is renamed, and
 *  that profile loses the mod's place until `mod sync` adopts the folder. */
export type RenameModResult =
  | { applied: true; lineRefusals: { profile: string; refusal: string }[]; unchanged?: true }
  | { applied: false; refusal: string };

// The folder, then a source mod's build configuration in `sourceFolder`, then the line in each of `profiles`, the
// active one first. A profile that does not list the mod is left as it was.
async function renameMod(
  { adapter, mEdit }: SourceModWriters,
  activeProfile: string, profiles: readonly string[], from: string, to: string, sourceFolder?: string,
): Promise<RenameModResult> {
  if (to.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  if (from === to) return { applied: true, lineRefusals: [], unchanged: true };
  try {
    await adapter.renameModFolder(from, to);
  } catch (err) {
    return refuse(err);
  }
  const configured = sourceFolder === undefined ? undefined : await mEdit.changeBuildConfiguration(sourceFolder, { output: to });
  if (configured !== undefined && isRefused(configured)) {
    try {
      await adapter.renameModFolder(to, from);
    } catch (err) {
      return { applied: false, refusal: `${configured.message} The folder could not be renamed back to "${from}": ${errorMessage(err)}` };
    }
    return { applied: false, refusal: configured.message };
  }
  const lineRefusals: { profile: string; refusal: string }[] = [];
  const ordered = [activeProfile, ...profiles.filter((profile) => profile !== activeProfile)];
  for (const profile of ordered) {
    const line = await changeModOrder(adapter, profile, () => [{ kind: 'renameMod', from, to }]);
    if (!line.applied) lineRefusals.push({ profile, refusal: line.refusal });
  }
  return { applied: true, lineRefusals };
}

type ModSyncResult =
  | { applied: true; added: string[]; dropped: string[] }
  | { applied: false; refusal: string };

const NO_MOD_FOLDERS = 'there is no folder for mods';

const describeEntry = (entry: EntryRef): string => (entry.kind === 'mod' ? entry.name : `${entry.name} (separator)`);

async function syncMods(adapter: InstanceAdapter): Promise<ModSyncResult> {
  const profile = await adapter.activeProfile();
  let added: string[] = [];
  let dropped: string[] = [];
  const outcome = await changeModOrder(adapter, profile, (order, folders) => {
    if (folders === undefined) throw new Error(NO_MOD_FOLDERS);
    const gone = order.filter((entry) => folders.holding(entry) === undefined);
    const held = new Set(order.flatMap((entry) => folders.holding(entry)?.path ?? []));
    const unlisted = folders.all.filter((folder) => !held.has(folder.path))
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

/** Mod sync over the active profile. */
export type ModSyncRun = () => Promise<ModSyncResult>;

/** `syncMods` bound to one instance. */
export function modSyncOver(adapter: InstanceAdapter): ModSyncRun {
  return () => syncMods(adapter);
}

/** The modlist's commands, bound to one instance: each takes the gesture's arguments only. */
export function modlistCommands(adapter: InstanceAdapter, mEdit: SourceModWriters['mEdit'], readStatus: ReadModStatus) {
  const entryKey: EntryKey = (entry) => adapter.entryKey(entry);
  return {
    setModsEnabled: (...args: TailOf<typeof setModsEnabled>) => setModsEnabled(adapter, ...args),
    moveMods: (...args: TailOf<typeof moveMods>) => moveMods(adapter, ...args),
    moveSeparators: (...args: TailOf<typeof moveSeparators>) => moveSeparators(adapter, ...args),
    markFiles: (...args: TailOf<typeof markFiles>) => markFiles({ adapter, mEdit }, ...args),
    insertSeparator: (...args: TailOf<typeof insertSeparator>) => insertSeparator(adapter, ...args),
    renameSeparator: (...args: TailOf<typeof renameSeparator>) => renameSeparator(adapter, ...args),
    deleteSeparators: (...args: TailOf<typeof deleteSeparators>) => deleteSeparators(adapter, ...args),
    uninstallMods: (...args: TailOf<typeof uninstallMods>) => uninstallMods(adapter, ...args),
    createEmptyMod: (...args: TailOf<typeof createEmptyMod>) => createEmptyMod(adapter, ...args),
    renameMod: (...args: TailOf<typeof renameMod>) => renameMod({ adapter, mEdit }, ...args),
    separatorNameRefusal: (...args: TailOf<typeof separatorNameRefusal>) => separatorNameRefusal(entryKey, ...args),
    renameModNameRefusal: (...args: TailOf<typeof renameModNameRefusal>) => renameModNameRefusal(entryKey, ...args),
    newModNameRefusal: (...args: TailOf<typeof newModNameRefusal>) => newModNameRefusal(entryKey, ...args),
    installMod: (...args: TailOf<typeof installMod>) => installMod({ adapter, readStatus }, ...args),
  };
}

export type ModlistCommands = ReturnType<typeof modlistCommands>;
