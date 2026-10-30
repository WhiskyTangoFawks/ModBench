import { argumentOfKind } from '../drivingLib/agentGesture';
import { carriedArgument, rowNameOf } from '../drivingLib/argument';
import { gestureEntry, isClickedRow } from '../drivingLib/gestureEntry';
import type { FocusedView } from '../drivingLib/focusedView';
import { MODS_KEY_ARGS } from './gestureEntry';
import { sameEntry, type EntryRef, type Instance, type InstanceValue } from '../instanceLoader/instance';
import { modNameOf } from '../instanceLoader/modName';
import type { ItemRefusal } from '../ports/selectionOutcome';
import type { Argument } from '../wire/argument';

const NEITHER = 'it is not a mod or a separator';

export interface ModsToRunDeps {
  /** The Toolbox's id, whose bar a gesture with no Argument runs under. */
  toolboxView: string;
  instance: Pick<Instance, 'value'>;
  /** The palette has no clicked row, so it takes the focused view's selection. */
  focusedView: Pick<FocusedView, 'id' | 'selection'>;
}

/** What a selection stands for: a separator stands for itself and its mods, or for its mods alone. */
export type Scope = 'modsAndSeparators' | 'modsOnly';

export interface ModsToRun {
  readonly mods: readonly string[];
  readonly refused: readonly ItemRefusal<string>[];
  readonly everyMod: boolean;
  readonly view: string;
}

const kindOf = (row: unknown): unknown => Reflect.get(carriedArgument(row) ?? {}, 'kind');
const isModOrSeparator = (row: unknown): boolean => kindOf(row) === 'mod' || kindOf(row) === 'separator';

function rowsOf(deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined): readonly unknown[] {
  if (clicked === undefined) return deps.focusedView.id() === MODS_KEY_ARGS.view ? deps.focusedView.selection() : [];
  return isModOrSeparator(clicked) ? gestureEntry(clicked, selected, () => [], isClickedRow).selection : [];
}

// modlist-repository.md, Every mod: every mod folder, in every profile, never the Mods view's rows.
const everyMod = (value: InstanceValue, scope: Scope): string[] =>
  (value.modFolders ?? []).filter(({ kind }) => scope === 'modsAndSeparators' || kind === 'mod').map(({ modName }) => modName);

/** The Mods view's title bar hands its command nothing, so it names every mod and the view (commands.md, Entry points are not gestures). */
export const everyModHere = ({ instance }: Pick<ModsToRunDeps, 'instance'>, scope: Scope = 'modsAndSeparators'): ModsToRun =>
  ({ mods: everyMod(instance.value, scope), refused: [], everyMod: true, view: MODS_KEY_ARGS.view });

// modlist-repository.md, Every mod, story 2: a separator stands for itself and its mods.
function modsHeldBy(kind: unknown, name: string, value: InstanceValue, scope: Scope): string[] | undefined {
  if (kind !== 'mod' && kind !== 'separator') return undefined;
  const asked: EntryRef = { kind, name };
  const entry = value.mods.find((listed) => sameEntry(value, listed, asked)) ?? asked;
  const modName = (held: EntryRef): string => modNameOf(value.modNames, held) ?? held.name;
  if (kind === 'mod') return [modName(entry)];
  const group = value.modGroups.groups.find(({ separator }) => separator.name === entry.name);
  const itself = scope === 'modsOnly' ? undefined : modNameOf(value.modNames, entry);
  return [...(itself === undefined ? [] : [itself]), ...(group?.mods.map(modName) ?? [])];
}

function modsOf(row: unknown, value: InstanceValue, scope: Scope): string[] | undefined {
  const name: unknown = Reflect.get(carriedArgument(row) ?? {}, 'name');
  return typeof name === 'string' ? modsHeldBy(kindOf(row), name, value, scope) : undefined;
}

// commands.md, The surface supplies the Argument: an agent call may supply all of it, and none is every mod.
export function modsOfAgent(argument: readonly Argument[], value: InstanceValue, scope: Scope = 'modsAndSeparators'): string[] {
  if (argument.length === 0) return everyMod(value, scope);
  const held = argument.flatMap((entry) => {
    const { kind, name } = argumentOfKind(entry, 'mod', 'separator');
    return modsHeldBy(kind, name, value, scope) ?? [];
  });
  return [...new Set(held)];
}

export function modsToRun(
  deps: ModsToRunDeps, clicked: unknown, selected: readonly unknown[] | undefined, scope: Scope = 'modsAndSeparators',
): ModsToRun {
  const { value } = deps.instance;
  const rows = rowsOf(deps, clicked, selected);
  if (rows.length === 0) return { mods: everyMod(value, scope), refused: [], everyMod: true, view: deps.toolboxView };
  const refused: ItemRefusal<string>[] = [];
  const mods = rows.flatMap((row) => {
    const held = modsOf(row, value, scope);
    if (held === undefined) refused.push({ item: rowNameOf(row), reason: NEITHER });
    return held ?? [];
  });
  return { mods: [...new Set(mods)], refused, everyMod: false, view: MODS_KEY_ARGS.view };
}
