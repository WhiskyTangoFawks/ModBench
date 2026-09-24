import * as vscode from 'vscode';
import type { ModlistNode, ModNode, SeparatorNode } from './ModListProvider';

/** The rows a Mods gesture's Argument is taken from. */
export interface GestureEntry {
  readonly clicked?: ModlistNode;
  readonly focused?: ModlistNode;
  readonly selection: readonly ModlistNode[];
}

// The entry every Mods gesture is registered with, pulled out so copy value's Mods text can build
// the same shape without registering a command of its own.
export function modsGestureEntry(
  clicked: ModlistNode | null | undefined,
  selected: readonly ModlistNode[] | undefined,
  viewSelection: () => readonly ModlistNode[],
): GestureEntry {
  return clicked ? { clicked, selection: selected ?? [clicked] } : { selection: viewSelection() };
}

/** VS Code passes a context menu the right-clicked row, and the selection only when that row is
 *  one of several selected. A key and the palette get nothing, and no stable API names the
 *  focused row. */
export function registerModsGesture(
  commandId: string,
  viewSelection: () => readonly ModlistNode[],
  run: (entry: GestureEntry, option?: unknown) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, (clicked?: ModlistNode | null, selected?: readonly ModlistNode[], option?: unknown) =>
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
