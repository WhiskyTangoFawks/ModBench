import { argumentOfKind } from '../drivingLib/agentGesture';
import { carriedArgument, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { MODS_KEY_ARGS } from './gestureEntry';
import { sameEntry, type EntryRef, type Instance, type InstanceValue } from '../instanceLoader/instance';
import { modNameOf } from '../instanceLoader/modName';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Argument, ArgumentOf } from '../wire/argument';
import { Refusal } from '../drivingLib/refusal';

const NEITHER = 'it is not a mod or a separator';

export interface ModsToRunDeps {
  /** The Toolbox's id, whose bar a gesture with no Argument runs under. */
  toolboxView: string;
  instance: Pick<Instance, 'value'>;
  /** The palette has no clicked row, so it takes the focused view's selection. */
  focusedView: Pick<FocusedView, 'id' | 'selection'>;
}

export interface ModsToRun {
  readonly mods: readonly string[];
  /** The source mods whose source folder the gesture records, which only update manifest takes. */
  readonly sourceFolders: readonly string[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly everyMod: boolean;
  readonly view: string;
}

const kindOf = (row: unknown): unknown => Reflect.get(carriedArgument(row) ?? {}, 'kind');
const isModOrSeparator = (row: unknown): boolean => kindOf(row) === 'mod' || kindOf(row) === 'separator';
const isSourceFolder = (row: unknown): boolean => kindOf(row) === 'folder' && typeof Reflect.get(carriedArgument(row) ?? {}, 'path') === 'string';

function rowsOf(deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined, takesSourceFolders: boolean): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === MODS_KEY_ARGS.view ? deps.focusedView.selection() : [];
  return isModOrSeparator(clicked) || (takesSourceFolders && isSourceFolder(clicked)) ? gestureEntry(clicked, selected, () => [], isClickedRow).selection : [];
}

// A source folder is named by its path in the instance (commands.md, the update manifest row).
const sourceModOfFolder = (path: unknown, { paths }: InstanceValue): string | undefined =>
  [...paths.sourceDirs].find(([, folder]) => folder === path)?.[0];

// modlist-repository.md, Every mod: every mod folder, in every profile, never the Mods view's rows. A separator has no manifest.
const everyMod = (value: InstanceValue): string[] =>
  (value.modFolders ?? []).filter(({ kind }) => kind === 'mod').map(({ modName }) => modName);

/** The Mods view's title bar hands its command nothing, so it names every mod and the view (commands.md, Entry points are not gestures). */
export const everyModHere = ({ instance }: Pick<ModsToRunDeps, 'instance'>): ModsToRun =>
  ({ mods: everyMod(instance.value), sourceFolders: [], refused: [], everyMod: true, view: MODS_KEY_ARGS.view });

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

/** Update manifest's agent call: the mods, and the source folders it names by path. */
export function modsAndSourceFoldersOfAgent(argument: readonly Argument[], value: InstanceValue): { mods: string[]; sourceFolders: string[] } {
  const isFolder = (entry: Argument): entry is ArgumentOf<'archive' | 'folder'> => entry.kind === 'folder';
  const folders = argument.filter(isFolder);
  const located = folders.map((entry) => ({ path: entry.path, mod: sourceModOfFolder(entry.path, value) }));
  const refused = located.filter(({ mod }) => mod === undefined);
  if (refused.length > 0) throw new Refusal(refused.map(({ path }) => `"${path}" is no source mod's source folder.`).join(' '));
  const named = argument.filter((entry) => !isFolder(entry));
  return {
    mods: argument.length > 0 && named.length === 0 ? [] : modsOfAgent(named, value),
    sourceFolders: [...new Set(located.flatMap(({ mod }) => mod ?? []))],
  };
}

export function modsToRun(
  deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined, takesSourceFolders = false,
): ModsToRun {
  const { value } = deps.instance;
  const rows = rowsOf(deps, clicked, selected, takesSourceFolders);
  if (rows.length === 0) return { mods: everyMod(value), sourceFolders: [], refused: [], everyMod: true, view: deps.toolboxView };
  const refused: ItemRefusal<string>[] = [];
  const sourceFolders: string[] = [];
  const mods = rows.flatMap((row) => {
    const folderMod = takesSourceFolders && isSourceFolder(row) ? sourceModOfFolder(Reflect.get(carriedArgument(row) ?? {}, 'path'), value) : undefined;
    if (folderMod !== undefined) { sourceFolders.push(folderMod); return []; }
    const held = modsOf(row, value);
    if (held === undefined) refused.push({ item: rowNameOf(row), reason: NEITHER });
    return held ?? [];
  });
  return { mods: [...new Set(mods)], sourceFolders: [...new Set(sourceFolders)], refused, everyMod: false, view: MODS_KEY_ARGS.view };
}
