import { argumentOfKind } from '../drivingLib/agentGesture';
import { carriedArgument, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { MODS_KEY_ARGS } from './gestureEntry';
import { sameEntry, type EntryRef, type Instance, type InstanceValue } from '../instanceLoader/instance';
import { modNameOf } from '../instanceLoader/modName';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Argument, ArgumentOf } from '../wire/argument';

const NEITHER = 'it is not a mod or a separator';
const NOT_A_SOURCE_FOLDER = 'it is not a source mod\'s source folder';

export interface ModsToRunDeps {
  /** The Toolbox's id, whose bar a gesture with no Argument runs under. */
  toolboxView: string;
  instance: Pick<Instance, 'value'>;
  /** The palette has no clicked row, so it takes the focused view's selection. */
  focusedView: Pick<FocusedView, 'id' | 'selection'>;
}

export interface ModsToRun {
  readonly mods: readonly string[];
  readonly sourceMods: readonly string[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly everyMod: boolean;
  readonly view: string;
}

const kindOf = (row: unknown): unknown => Reflect.get(carriedArgument(row) ?? {}, 'kind');
const isModOrSeparator = (row: unknown): boolean => kindOf(row) === 'mod' || kindOf(row) === 'separator';
const isSourceFolder = (row: unknown): boolean => kindOf(row) === 'folder' && typeof Reflect.get(carriedArgument(row) ?? {}, 'path') === 'string';

function rowsOf(deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined, isTaken: (row: unknown) => boolean): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === MODS_KEY_ARGS.view ? deps.focusedView.selection() : [];
  return isTaken(clicked) ? gestureEntry(clicked, selected, () => [], isClickedRow).selection : [];
}

const sourceModOfFolder = (path: unknown, { paths }: InstanceValue): string | undefined =>
  [...paths.sourceDirs].find(([, folder]) => folder === path)?.[0];

// modlist-repository.md, Every mod: every mod folder, in every profile, never the Mods view's rows. A separator has no manifest.
const everyMod = (value: InstanceValue): string[] =>
  (value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName }) => modName);

/** The Mods view's title bar hands its command nothing, so it names every mod and the view (commands.md, Entry points are not gestures). */
export const everyModHere = ({ instance }: Pick<ModsToRunDeps, 'instance'>): ModsToRun =>
  ({ mods: everyMod(instance.value), sourceMods: [], refused: [], everyMod: true, view: MODS_KEY_ARGS.view });

// modlist-repository.md, Every mod, story 2: a separator stands for its mods.
function modsHeldBy(kind: unknown, name: string, value: InstanceValue): string[] | undefined {
  if (kind !== 'mod' && kind !== 'separator') return undefined;
  const asked: EntryRef = { kind, name };
  const entry = value.mods.find((listed) => sameEntry(value, listed, asked)) ?? asked;
  const modName = (held: EntryRef): string => modNameOf(value.modNames, held) ?? held.name;
  if (kind === 'mod') return [modName(entry)];
  const group = value.modGroups.groups.find(({ separator }) => separator.name === entry.name);
  return group?.mods.map(modName) ?? [];
}

function modsOf(row: unknown, value: InstanceValue): string[] | undefined {
  const name: unknown = Reflect.get(carriedArgument(row) ?? {}, 'name');
  return typeof name === 'string' ? modsHeldBy(kindOf(row), name, value) : undefined;
}

// modlist-repository.md, Every mod, story 1: an agent call may supply all of it, and none is every mod.
export function modsOfAgent(argument: readonly Argument[], value: InstanceValue): string[] {
  if (argument.length === 0) return everyMod(value);
  const held = argument.flatMap((entry) => {
    const { kind, name } = argumentOfKind(entry, 'mod', 'separator');
    return modsHeldBy(kind, name, value) ?? [];
  });
  return [...new Set(held)];
}

/** Update manifest's agent call: the mods, and the source mods whose source folder it names by path. */
export function modsAndSourceModsOfAgent(argument: readonly Argument[], value: InstanceValue): { mods: string[]; sourceMods: string[]; refused: ItemRefusal<string>[] } {
  const isFolder = (entry: Argument): entry is ArgumentOf<'archive' | 'folder'> => entry.kind === 'folder';
  const located = argument.filter(isFolder).map(({ path }) => ({ path, mod: sourceModOfFolder(path, value) }));
  const named = argument.filter((entry) => !isFolder(entry));
  return {
    mods: argument.length > 0 && named.length === 0 ? [] : modsOfAgent(named, value),
    sourceMods: [...new Set(located.flatMap(({ mod }) => mod ?? []))],
    refused: located.filter(({ mod }) => mod === undefined).map(({ path }) => ({ item: path, reason: NOT_A_SOURCE_FOLDER })),
  };
}

const sourceModOfFolderRow = (row: unknown, value: InstanceValue): string | undefined =>
  (isSourceFolder(row) ? sourceModOfFolder(Reflect.get(carriedArgument(row) ?? {}, 'path'), value) : undefined);

function toRun(
  deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined, sourceModOf: (row: unknown, value: InstanceValue) => string | undefined,
): ModsToRun {
  const { value } = deps.instance;
  const rows = rowsOf(deps, clicked, selected, (row) => isModOrSeparator(row) || sourceModOf(row, value) !== undefined);
  if (rows.length === 0) return { mods: everyMod(value), sourceMods: [], refused: [], everyMod: true, view: deps.toolboxView };
  const refused: ItemRefusal<string>[] = [];
  const sourceMods: string[] = [];
  const mods = rows.flatMap((row) => {
    const sourceMod = sourceModOf(row, value);
    if (sourceMod !== undefined) { sourceMods.push(sourceMod); return []; }
    const held = modsOf(row, value);
    if (held === undefined) refused.push({ item: rowNameOf(row), reason: NEITHER });
    return held ?? [];
  });
  return { mods: [...new Set(mods)], sourceMods: [...new Set(sourceMods)], refused, everyMod: false, view: MODS_KEY_ARGS.view };
}

export const modsToRun = (deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined): ModsToRun =>
  toRun(deps, clicked, selected, () => undefined);

/** Update manifest also takes a source folder, which stands for its source mod. */
export const modsAndSourceModsToRun = (deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined): ModsToRun =>
  toRun(deps, clicked, selected, sourceModOfFolderRow);
