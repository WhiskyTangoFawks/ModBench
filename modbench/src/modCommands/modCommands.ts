import { refuse } from '../coreLib/refuse';
import { errorMessage } from '../ports/errorMessage';
import type { ItemRefusal, SelectionOutcome } from '../ports/selectionOutcome';
import type { MoveToTrash } from '../ports/trash';
import {
  entryNotFound, fileInFolder, sameEntry, type DecideModOrder, type EntryRef, type FileOrigin, type FileRead, type InstanceAdapter,
  type ModOrderChange, type MovePlace, type OrderEnd, type OriginFileMark, type PublisherTag, type PublisherTagChange, type SeparatorsPlace, type SourceMods,
} from '../instanceAdapter/instanceAdapter';
import { goneFromDisk } from '../coreLib/commandRefusals';
import { EMPTY_MOD_NAME, entryNameRefusal, newModNameRefusal, type EntryKey } from './nameRefusals';
import type { TailOf } from '../coreLib/boundCommand';
import { selectionOutcomeOf, type CommandResult, type SelectionResult } from '../coreLib/commandResult';
import { isRefused, type MEditClient, type ReadModStatus } from '../client';
import { installMod, upgradeLoss } from './install';
export type { SelectionResult };
export type { FomodAnswer, FomodDialog, FomodLanded, FomodStepChoice, InstallTarget } from '../instanceAdapter/instanceAdapter';
export type { ModPackage } from './install';

type Landing = CommandResult<Awaited<ReturnType<InstanceAdapter['changeModOrder']>>>;

async function landIn(adapter: InstanceAdapter, profile: string, decide: DecideModOrder): Promise<Landing> {
  try {
    return { applied: true, ...await adapter.changeModOrder(profile, decide) };
  } catch (err) {
    return refuse(err);
  }
}

async function changeModOrderLanding(adapter: InstanceAdapter, decide: DecideModOrder): Promise<Landing> {
  try {
    return await landIn(adapter, await adapter.activeProfile(), decide);
  } catch (err) {
    return refuse(err);
  }
}

const wrote = (result: Landing): CommandResult => (result.applied ? { applied: true, wrote: result.wrote } : result);

const changeModOrder = async (adapter: InstanceAdapter, decide: DecideModOrder): Promise<CommandResult> =>
  wrote(await changeModOrderLanding(adapter, decide));

// A separator written, and the name it was written under.
type SeparatorResult = CommandResult<{ wrote: boolean; name: string }>;

async function changeSeparator(adapter: InstanceAdapter, decide: DecideModOrder): Promise<SeparatorResult> {
  const result = await changeModOrderLanding(adapter, decide);
  if (!result.applied) return result;
  const name = result.landed.flatMap((change) => (change.kind === 'addSeparator' ? [change.separator] : change.kind === 'renameSeparator' ? [change.to] : []))[0];
  if (name === undefined) throw new Error('The adapter landed no separator.');
  return { applied: true, wrote: result.wrote, name };
}

type EntryKind = EntryRef['kind'];

// A command names an entry as the mod manager matches names.
const isListed = (adapter: InstanceAdapter, order: readonly EntryRef[], entry: EntryRef): boolean =>
  order.some((e) => sameEntry(adapter, e, entry));

// Decided from mod order as it stands when the changes land, so an item gone since the view last
// rendered is refused by name while the rest land in the same write.
async function changeSelection(
  adapter: InstanceAdapter, kind: EntryKind, names: readonly string[],
  changesFor: (found: readonly string[]) => readonly ModOrderChange[],
): Promise<SelectionResult<string>> {
  let outcome: SelectionOutcome<string> = { landed: [], refused: [] };
  const result = await changeModOrder(adapter, (order) => {
    const landed = names.filter((name) => isListed(adapter, order, { kind, name }));
    const refused = names.filter((name) => !landed.includes(name)).map((name) => ({ item: name, reason: entryNotFound({ kind, name }) }));
    outcome = { landed, refused };
    return changesFor(landed);
  });
  return result.applied ? { applied: true, outcome } : result;
}

// `modbench.mod.enable` / `modbench.mod.disable`, over the whole selection in one write.
function setModsEnabled(
  adapter: InstanceAdapter, modNames: readonly string[], enabled: boolean,
): Promise<SelectionResult<string>> {
  return changeSelection(adapter, 'mod', modNames, (found) =>
    found.map((mod) => ({ kind: 'enable', mod, enabled })));
}

export type { EntryRef, MovePlace, OrderEnd, OriginFileMark, SeparatorsPlace } from '../instanceAdapter/instanceAdapter';

const SEPARATOR_PLACES =
  'A separator lands beside another separator or at an end of mod order, never beside a mod or among the ungrouped mods.';

const isSeparatorsPlace = (place: MovePlace): place is SeparatorsPlace =>
  place.kind === 'separator' || place.kind === 'modOrder';

const isMoving = (adapter: InstanceAdapter, kind: EntryKind, names: readonly string[], target: EntryRef): boolean =>
  names.some((name) => sameEntry(adapter, { kind, name }, target));

const movingTarget = (name: string): { applied: false; refusal: string } => ({ applied: false, refusal: `The target is "${name}", which is moving.` });

// `modbench.mod.move` over mods (mods.md, Pickers, Move): they land as one block, in their own
// order, at the `end` of the place. A gone mod is refused by name; a gone or moving target
// refuses the whole move.
async function moveMods(
  adapter: InstanceAdapter, modNames: readonly string[], place: MovePlace, end: OrderEnd,
): Promise<SelectionResult<string>> {
  if (place.kind === 'mod' && isMoving(adapter, 'mod', modNames, place)) return movingTarget(place.name);
  return changeSelection(adapter, 'mod', modNames, (found) => [{ kind: 'moveMods', mods: found, place, end }]);
}

// `modbench.mod.move` over separators: each brings every mod it holds,
// and they land on the `end` side of the place. A gone or moving target, or a place no separator
// can take, refuses the move.
async function moveSeparators(
  adapter: InstanceAdapter, separatorNames: readonly string[], place: MovePlace, end: OrderEnd,
): Promise<SelectionResult<string>> {
  if (!isSeparatorsPlace(place)) return { applied: false, refusal: SEPARATOR_PLACES };
  if (place.kind === 'separator' && isMoving(adapter, 'separator', separatorNames, place)) return movingTarget(place.name);
  return changeSelection(adapter, 'separator', separatorNames, (found) =>
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

interface ReadFile {
  readonly file: OriginFileRef;
  readonly includedPath: string;
}

type SourceGroups = ReadonlyMap<string | undefined, readonly ReadFile[]>;

function bySourceFolder(reads: readonly ReadFile[], sourceMods: SourceMods): SourceGroups {
  const groups = new Map<string | undefined, ReadFile[]>();
  for (const read of reads) {
    const { origin } = read.file;
    const sourceFolder = origin.kind === 'mod' ? sourceMods.folderOf(origin.name) : undefined;
    groups.set(sourceFolder, [...(groups.get(sourceFolder) ?? []), read]);
  }
  return groups;
}

type ExclusionChange = (sourceFolder: string, files: readonly ReadFile[], to: OriginFileMark) => ReturnType<MEditClient['changeBuildConfiguration']>;

// Each source mod's refusal by its source folder; or, when mEdit cannot be reached, the whole selection's, with the
// configurations already changed put back.
async function configureEach(
  change: ExclusionChange, groups: SourceGroups, mark: OriginFileMark,
): Promise<{ refusals: ReadonlyMap<string, string> } | { unreachable: string }> {
  const refusals = new Map<string, string>();
  const configured: [string, readonly ReadFile[]][] = [];
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
  adapter: InstanceAdapter, change: ExclusionChange, sourceFolder: string, reads: readonly ReadFile[], mark: OriginFileMark,
): Promise<SelectionOutcome<OriginFileRef>> {
  const outcome = await markEach(adapter, reads.map(({ file }) => file), mark);
  if (outcome.refused.length === 0) return outcome;
  const unmarked = reads.filter(({ file }) => outcome.refused.some(({ item }) => item === file));
  const takenBack = await change(sourceFolder, unmarked, UNMARK[mark]);
  if (!isRefused(takenBack)) return outcome;
  return {
    landed: outcome.landed,
    refused: outcome.refused.map(({ item, reason }) => ({
      item, reason: `${reason} Its change to the build configuration could not be taken back: ${takenBack.message}`,
    })),
  };
}

async function readEach(
  adapter: InstanceAdapter, files: readonly OriginFileRef[],
): Promise<{ read: ReadFile[]; unread: ItemRefusal<OriginFileRef>[] }> {
  const read: ReadFile[] = [];
  const unread: ItemRefusal<OriginFileRef>[] = [];
  for (const file of files) {
    try {
      const found = await adapter.originFile(file.origin, file.relativePath);
      if (found === undefined) unread.push({ item: file, reason: goneFromDisk(file.relativePath) });
      else read.push({ file, includedPath: found.includedPath });
    } catch (err) {
      unread.push({ item: file, reason: refuse(err).refusal });
    }
  }
  return { read, unread };
}

// A refusal all a source mod's files share writes none of them (commands.md, A selection is one gesture).
async function markFiles(
  { adapter, mEdit }: SourceModWriters, files: readonly OriginFileRef[], mark: OriginFileMark,
): Promise<SelectionResult<OriginFileRef>> {
  let sourceMods: SourceMods;
  try {
    sourceMods = await adapter.sourceMods();
  } catch (err) {
    return refuse(err);
  }
  const { read, unread } = await readEach(adapter, files);
  const change: ExclusionChange = (sourceFolder, of, to) =>
    mEdit.changeBuildConfiguration(sourceFolder, exclusionChange(to, of.map(({ includedPath }) => includedPath)));
  const groups = bySourceFolder(read, sourceMods);
  const configured = await configureEach(change, groups, mark);
  if ('unreachable' in configured) return { applied: false, refusal: configured.unreachable };
  const landed: OriginFileRef[] = [];
  const refused: ItemRefusal<OriginFileRef>[] = [...unread];
  for (const [sourceFolder, inIt] of groups) {
    const refusal = sourceFolder === undefined ? undefined : configured.refusals.get(sourceFolder);
    const outcome = sourceFolder === undefined ? await markEach(adapter, inIt.map(({ file }) => file), mark)
      : refusal === undefined ? await markInSourceMod(adapter, change, sourceFolder, inIt, mark)
        : { landed: [], refused: inIt.map(({ file }) => ({ item: file, reason: refusal })) };
    landed.push(...outcome.landed);
    refused.push(...outcome.refused);
  }
  return { applied: true, outcome: { landed, refused } };
}

/** A row `modbench.mod.addPublisherTag` and `modbench.mod.removePublisherTag` act on: a mod, or a file or folder in one by
 *  its path there. */
export interface PublisherTagRow {
  readonly origin: FileOrigin;
  readonly relativePath?: string;
}

async function publisherTagPath(adapter: InstanceAdapter, tag: PublisherTag, row: PublisherTagRow): Promise<string | ItemRefusal<PublisherTagRow>> {
  const { origin, relativePath } = row;
  if (origin.kind === 'runtimeOutput') return { item: row, reason: 'Overwrite is not a mod.' };
  if (relativePath !== undefined && !tag.marksPaths) return { item: row, reason: `${tag.name} marks mods only.` };
  const folder = await adapter.modFolderPath(origin.name);
  if (folder === undefined) return { item: row, reason: goneFromDisk(origin.name) };
  return relativePath === undefined ? folder : fileInFolder(folder, relativePath);
}

async function changePublisherTag(
  adapter: InstanceAdapter, change: PublisherTagChange, tagName: string, rows: readonly PublisherTagRow[],
): Promise<SelectionResult<PublisherTagRow>> {
  const tag = adapter.publisherTags.find(({ name }) => name === tagName);
  if (tag === undefined) return { applied: false, refusal: `The publisher declares no publisher tag "${tagName}". It declares ${adapter.publisherTags.map(({ name }) => name).join(', ')}.` };
  try {
    const resolved = await Promise.all(rows.map(async (row) => ({ row, path: await publisherTagPath(adapter, tag, row) })));
    const asked = resolved.flatMap(({ row, path }) => (typeof path === 'string' ? [{ row, path }] : []));
    const refusals = asked.length === 0 ? [] : await adapter.changePublisherTag(change, tagName, asked.map(({ path }) => path));
    const refusedBefore = resolved.flatMap(({ path }) => (typeof path === 'string' ? [] : [path]));
    const refusedByPublisher = asked.flatMap(({ row, path }) => {
      const refusal = refusals.find((refused) => refused.path === path);
      return refusal === undefined ? [] : [{ item: row, reason: refusal.reason }];
    });
    const refused = [...refusedBefore, ...refusedByPublisher];
    return { applied: true, outcome: { landed: rows.filter((row) => !refused.some(({ item }) => item === row)), refused } };
  } catch (err) {
    return refuse(err);
  }
}

const keyOf = (adapter: InstanceAdapter): EntryKey => (entry) => adapter.entryKey(entry);

const SEPARATOR_NAME_CLASH = 'A separator with this name already exists';
const MOD_NAME_CLASH = 'A mod with this name already exists';
const MOD_NAME_WITH_PATH_SEPARATOR = 'A mod name cannot contain / or \\';

// Why `requested` cannot name a separator, or `undefined` when it can: a separator of that name is
// listed or has a folder, compared without case. `own`, the separator being renamed, is no clash.
async function separatorNameRefusal(adapter: InstanceAdapter, requested: string, own?: string): Promise<string | undefined> {
  return entryNameRefusal(keyOf(adapter), await adapter.modOrder(), 'separator', requested, SEPARATOR_NAME_CLASH, own);
}

// Why `requested` cannot rename mod `own`, or `undefined` when it can: it holds a path separator, or
// another mod of that name is listed or has a folder, compared without case.
async function renameModNameRefusal(adapter: InstanceAdapter, requested: string, own: string): Promise<string | undefined> {
  return /[\\/]/.test(requested) ? MOD_NAME_WITH_PATH_SEPARATOR
    : entryNameRefusal(keyOf(adapter), await adapter.modOrder(), 'mod', requested, MOD_NAME_CLASH, own);
}

async function newModNameRefusalInInstance(adapter: InstanceAdapter, name: string): Promise<string | undefined> {
  return newModNameRefusal(keyOf(adapter), await adapter.modOrder(), name);
}

async function refusedName(refusal: Promise<string | undefined>): Promise<{ applied: false; refusal: string } | undefined> {
  try {
    const reason = await refusal;
    return reason === undefined ? undefined : { applied: false, refusal: reason };
  } catch (err) {
    return refuse(err);
  }
}

// Insert a new enabled separator next to the anchor (mods.md, Add separator); the adapter places it.
async function insertSeparator(
  adapter: InstanceAdapter, requested: string, anchor: EntryRef,
): Promise<SeparatorResult> {
  const refused = await refusedName(separatorNameRefusal(adapter, requested));
  if (refused) return refused;
  return changeSeparator(adapter, () => [{ kind: 'addSeparator', separator: requested, anchor }]);
}

// Rename a separator in place, and its folder with it.
async function renameSeparator(
  adapter: InstanceAdapter, oldName: string, requested: string,
): Promise<SeparatorResult> {
  const refused = await refusedName(separatorNameRefusal(adapter, requested, oldName));
  if (refused) return refused;
  return changeSeparator(adapter, () => [{ kind: 'renameSeparator', from: oldName, to: requested }]);
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
  adapter: InstanceAdapter, kind: EntryKind, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionResult<TrashedEntry>> {
  let order: readonly EntryRef[];
  try {
    ({ mods: order } = await adapter.modOrder());
  } catch (err) {
    return refuse(err);
  }
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
  const lines = await changeModOrder(adapter, () => toUnlist.map((name) => dropOf({ kind, name })));
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
  adapter: InstanceAdapter, names: readonly string[], trash: MoveToTrash,
): Promise<SelectionResult<TrashedEntry>> {
  return trashThenUnlist(adapter, 'separator', names, trash);
}

const readOrRefuse = async <T>(read: () => Promise<FileRead<T>>): Promise<FileRead<T>> => {
  try {
    return await read();
  } catch (err) {
    return { kind: 'unreadable', reason: errorMessage(err) };
  }
};

// A landed mod. `markRefusal` is set when its downloaded file could not be marked uninstalled,
// and the uninstall still stands. A line not truly gone marks nothing, so never beside
interface UninstalledMod extends TrashedEntry {
  markRefusal?: string;
  /** Why its publisher tags could not be removed: they still name the mod's folder. */
  tagRefusal?: string;
}

// `modbench.mod.uninstall` over the selection (mods.md, Reporting, story 4). The installation file is read before
// the folder that records it is trashed.
async function uninstallMods(
  adapter: InstanceAdapter, mods: readonly string[], trash: MoveToTrash,
): Promise<SelectionResult<UninstalledMod>> {
  const installedFrom = new Map(await Promise.all(mods.map(async (mod) => [mod, await readOrRefuse(() => adapter.modMetadata(mod))] as const)));
  const folders = await Promise.all(mods.map(async (mod) => [mod, await adapter.modFolderPath(mod).catch(() => undefined)] as const));
  const result = await trashThenUnlist(adapter, 'mod', mods, trash);
  if (!result.applied) return result;
  const tagRefusal = await removePublisherTags(adapter, result.outcome.landed.flatMap(({ name }) => folders.find(([mod]) => mod === name)?.[1] ?? []));
  const landed: UninstalledMod[] = [];
  for (const trashed of result.outcome.landed) {
    const entry: UninstalledMod = tagRefusal === undefined ? trashed : { ...trashed, tagRefusal };
    const read = installedFrom.get(entry.name);
    const downloadedFile = read?.kind === 'read' ? read.answer.installationFile?.name : undefined;
    if (read?.kind === 'unreadable') {
      landed.push(entry.lineRefusal === undefined ? { ...entry, markRefusal: read.reason } : entry);
      continue;
    }
    if (entry.lineRefusal !== undefined || downloadedFile === undefined) {
      landed.push(entry);
      continue;
    }
    try {
      await adapter.markDownloadedFile(downloadedFile, 'Uninstalled');
      landed.push(entry);
    } catch (err) {
      landed.push({ ...entry, markRefusal: errorMessage(err) });
    }
  }
  return { applied: true, outcome: { landed, refused: result.outcome.refused } };
}

// The publisher tags on the folders, removed in one write; why they could not be, or undefined.
async function removePublisherTags(adapter: InstanceAdapter, folders: readonly string[]): Promise<string | undefined> {
  if (adapter.publisherTags.length === 0 || folders.length === 0) return undefined;
  try {
    await adapter.followModFolders(folders.map((from) => ({ from })));
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

/** `lineRefusal` is set only when the folder landed and the line did not: the folder stays, and
 *  `mod sync` adopts it next (common.md, Reporting: "A gesture landed, but part of it failed"). */
export type CreateEmptyModResult =
  | { applied: true; wrote: boolean; lineRefusal?: string }
  | { applied: false; refusal: string };

const listMod = (adapter: InstanceAdapter, name: string): Promise<CommandResult> =>
  changeModOrder(adapter, () => [{ kind: 'addAtWinningEnd', entry: { kind: 'mod', name } }]);

// A mod's folder plus a disabled line at the winning end of mod order — nothing else. A name a
// folder already holds is refused.
async function createEmptyMod(adapter: InstanceAdapter, name: string): Promise<CreateEmptyModResult> {
  if (name.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  try {
    await adapter.createModFolder(name);
  } catch (err) {
    return refuse(err);
  }
  const line = await listMod(adapter, name);
  if (!line.applied) return { applied: true, wrote: false, lineRefusal: line.refusal };
  return line;
}

/** `lineRefusals` names each profile whose line could not be renamed: the folder is renamed, and
 *  that profile loses the mod's place until `mod sync` adopts the folder. */
export type RenameModResult =
  | { applied: true; lineRefusals: { profile: string; refusal: string }[]; unchanged?: true }
  | { applied: false; refusal: string };

// The publisher tags on a mod's folder, moved to where the new name puts it: the folders moved, or undefined when the
// instance has no publisher tags to move.
async function moveTagsWithFolder(adapter: InstanceAdapter, from: string, to: string): Promise<{ from: string; to: string } | undefined> {
  if (adapter.publisherTags.length === 0) return undefined;
  const [fromFolder, toFolder] = await Promise.all([adapter.modFolderPath(from), adapter.modFolderPath(to)]);
  if (fromFolder === undefined || toFolder === undefined) return undefined;
  await adapter.followModFolders([{ from: fromFolder, to: toFolder }]);
  return { from: fromFolder, to: toFolder };
}

// The publisher tags, then the folder, then a source mod's build configuration, then the line in each profile, the active one first. A
// profile that does not list the mod is left as it was.
async function renameMod({ adapter, mEdit }: SourceModWriters, from: string, to: string): Promise<RenameModResult> {
  if (to.trim() === '') return { applied: false, refusal: EMPTY_MOD_NAME };
  if (from === to) return { applied: true, lineRefusals: [], unchanged: true };
  const refused = await refusedName(renameModNameRefusal(adapter, to, from));
  if (refused) return refused;
  let activeProfile: string;
  let profiles: readonly string[];
  let sourceFolder: string | undefined;
  let tagsMoved: { from: string; to: string } | undefined;
  try {
    [activeProfile, profiles, sourceFolder] = await Promise.all([
      adapter.activeProfile(), adapter.profiles(), adapter.sourceMods().then((sourceMods) => sourceMods.folderOf(from)),
    ]);
    tagsMoved = await moveTagsWithFolder(adapter, from, to);
  } catch (err) {
    return refuse(err);
  }
  const putBack = async (refusal: string, folderMoved: boolean): Promise<RenameModResult> => {
    const failures: string[] = [];
    try {
      if (folderMoved) await adapter.renameModFolder(to, from);
    } catch (err) {
      failures.push(`The folder could not be renamed back to "${from}": ${errorMessage(err)}`);
    }
    try {
      if (tagsMoved !== undefined) await adapter.followModFolders([{ from: tagsMoved.to, to: tagsMoved.from }]);
    } catch (err) {
      failures.push(`Its publisher tags could not be moved back: ${errorMessage(err)}`);
    }
    return { applied: false, refusal: [refusal, ...failures].join(' ') };
  };
  try {
    await adapter.renameModFolder(from, to);
  } catch (err) {
    return putBack(errorMessage(err), false);
  }
  const configured = sourceFolder === undefined ? undefined : await mEdit.changeBuildConfiguration(sourceFolder, { output: to });
  if (configured !== undefined && isRefused(configured)) return putBack(configured.message, true);
  const lineRefusals: { profile: string; refusal: string }[] = [];
  const ordered = [activeProfile, ...profiles.filter((profile) => profile !== activeProfile)];
  for (const profile of ordered) {
    const line = wrote(await landIn(adapter, profile, () => [{ kind: 'renameMod', from, to }]));
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
  let added: string[] = [];
  let dropped: string[] = [];
  const outcome = await changeModOrder(adapter, (order, folders) => {
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
export function modCommands(adapter: InstanceAdapter, mEdit: SourceModWriters['mEdit'], readStatus: ReadModStatus) {
  return {
    setModsEnabled: (...args: TailOf<typeof setModsEnabled>) => setModsEnabled(adapter, ...args),
    moveMods: (...args: TailOf<typeof moveMods>) => moveMods(adapter, ...args),
    moveSeparators: (...args: TailOf<typeof moveSeparators>) => moveSeparators(adapter, ...args),
    markFiles: (...args: TailOf<typeof markFiles>) => markFiles({ adapter, mEdit }, ...args),
    changePublisherTag: (...args: TailOf<typeof changePublisherTag>) => changePublisherTag(adapter, ...args),
    insertSeparator: (...args: TailOf<typeof insertSeparator>) => insertSeparator(adapter, ...args),
    renameSeparator: (...args: TailOf<typeof renameSeparator>) => renameSeparator(adapter, ...args),
    deleteSeparators: (...args: TailOf<typeof deleteSeparators>) => deleteSeparators(adapter, ...args),
    uninstallMods: (...args: TailOf<typeof uninstallMods>) => uninstallMods(adapter, ...args),
    createEmptyMod: (...args: TailOf<typeof createEmptyMod>) => createEmptyMod(adapter, ...args),
    renameMod: (...args: TailOf<typeof renameMod>) => renameMod({ adapter, mEdit }, ...args),
    separatorNameRefusal: (...args: TailOf<typeof separatorNameRefusal>) => separatorNameRefusal(adapter, ...args),
    renameModNameRefusal: (...args: TailOf<typeof renameModNameRefusal>) => renameModNameRefusal(adapter, ...args),
    newModNameRefusal: (...args: TailOf<typeof newModNameRefusalInInstance>) => newModNameRefusalInInstance(adapter, ...args),
    names: adapter.names,
    installMod: (...args: TailOf<typeof installMod>) => installMod({ adapter, readStatus, listMod: (name) => listMod(adapter, name) }, ...args),
    upgradeLoss: (...args: TailOf<typeof upgradeLoss>) => upgradeLoss({ adapter, readStatus }, ...args),
  };
}

export type ModCommands = ReturnType<typeof modCommands>;
