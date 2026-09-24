import * as vscode from 'vscode';
import type { ModlistNode, ModNode, SeparatorNode } from './ModListProvider';

/** The rows a Mods gesture's Argument is taken from. */
export interface GestureEntry {
  readonly clicked?: ModlistNode;
  readonly focused?: ModlistNode;
  readonly selection: readonly ModlistNode[];
}

/** The `args` a Mods key passes, so a command other surfaces share knows the key is the Mods
 *  view's. */
export const MODS_KEY_ARGS = { view: 'modbench.modList' } as const;

export function isModsKeyArgs(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'view' in value && value.view === MODS_KEY_ARGS.view;
}

function isRow(value: unknown): value is ModlistNode {
  return value instanceof vscode.TreeItem;
}

// No stable API names the focused row, so from a key or the palette a selection of one row
// stands for it.
export function modsGestureEntry(
  clicked: unknown,
  selected: readonly ModlistNode[] | undefined,
  viewSelection: () => readonly ModlistNode[],
): GestureEntry {
  if (isRow(clicked)) return { clicked, selection: selected ?? [clicked] };
  const selection = viewSelection();
  const [only] = selection;
  return selection.length === 1 && only !== undefined ? { focused: only, selection } : { selection };
}

/** VS Code passes a context menu the right-clicked row, and the selection only when that row is
 *  one of several selected. A key passes its own `args`, and the palette nothing. */
export function registerModsGesture(
  commandId: string,
  viewSelection: () => readonly ModlistNode[],
  run: (entry: GestureEntry, option?: unknown) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, (clicked?: unknown, selected?: readonly ModlistNode[], option?: unknown) =>
    run(modsGestureEntry(clicked, selected, viewSelection), option));
}

type ArgumentRow = ModNode | SeparatorNode;
type ArgumentKind = ArgumentRow['kind'];
type RowOf<K extends ArgumentKind> = Extract<ArgumentRow, { kind: K }>;

const isOf = <K extends ArgumentKind>(kinds: readonly K[]) =>
  (row: ModlistNode): row is RowOf<K> => kinds.some((kind) => kind === row.kind);

/** The Argument of a gesture the catalog calls singular: the right-clicked or focused row, when
 *  the gesture takes its kind. */
export function singularArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K> | undefined {
  const anchor = entry.clicked ?? entry.focused;
  return anchor !== undefined && isOf(kinds)(anchor) ? anchor : undefined;
}

/** Move's own Argument: one kind at a time, so a mixed selection narrows to the right-clicked or
 *  focused row's kind. For the catalog's own plural (commands.md, Argument: "the whole
 *  selection"), use `selectionArgument` instead. */
export function pluralArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K>[] {
  const anchor = entry.clicked ?? entry.focused;
  const taken = anchor === undefined ? kinds : kinds.filter((kind) => kind === anchor.kind);
  return entry.selection.filter(isOf(taken));
}

/** The catalog's own plural Argument (commands.md, Argument: "the whole selection"), of the kinds
 *  given: no narrowing to the anchor row's kind, so a mixed selection keeps every kind. */
export function selectionArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K>[] {
  return entry.selection.filter(isOf(kinds));
}

/** What the Mods keys' and palette entries' `when` clauses read off the selection, since neither
 *  is handed a row. */
export interface ModsKeyContext {
  readonly selectionToggle?: 'enable' | 'disable';
  readonly selectionKind?: ArgumentKind;
  readonly singleRow: boolean;
  readonly holdsEnabledMod: boolean;
  readonly holdsDisabledMod: boolean;
}

export function modsKeyContext(selection: readonly ModlistNode[], isEnabled: (row: ModNode) => boolean): ModsKeyContext {
  const mods = selection.filter(isOf(['mod']));
  const [firstMod] = mods;
  const kinds = new Set(selection.filter(isOf(['mod', 'separator'])).map((row) => row.kind));
  const [onlyKind] = kinds;
  return {
    selectionToggle: firstMod && toggleOf(isEnabled(firstMod)),
    selectionKind: kinds.size === 1 ? onlyKind : undefined,
    singleRow: selection.length === 1,
    holdsEnabledMod: mods.some(isEnabled),
    holdsDisabledMod: mods.some((row) => !isEnabled(row)),
  };
}

function toggleOf(enabled: boolean): 'enable' | 'disable' {
  return enabled ? 'disable' : 'enable';
}
