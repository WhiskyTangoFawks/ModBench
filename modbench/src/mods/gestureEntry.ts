import * as vscode from 'vscode';
import type { ModlistNode, ModNode, SeparatorNode } from './ModListProvider';

/** What an entry point hands a Mods gesture: a context menu the right-clicked row, a key the
 *  focused row, each with the selection, and the palette the selection alone. */
export interface GestureEntry {
  readonly clicked?: ModlistNode;
  readonly focused?: ModlistNode;
  readonly selection: readonly ModlistNode[];
}

/** VS Code passes a context menu the right-clicked row, and the selection only when that row is
 *  one of several selected. A key and the palette get nothing, and no stable API names the
 *  focused row. */
export function registerModsGesture(
  commandId: string,
  viewSelection: () => readonly ModlistNode[],
  run: (entry: GestureEntry) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, (clicked?: ModlistNode | null, selected?: readonly ModlistNode[]) =>
    run(clicked ? { clicked, selection: selected ?? [clicked] } : { selection: viewSelection() }));
}

type ArgumentRow = ModNode | SeparatorNode;
type ArgumentKind = ArgumentRow['kind'];
type RowOf<K extends ArgumentKind> = Extract<ArgumentRow, { kind: K }>;

const isOf = <K extends ArgumentKind>(kinds: readonly K[]) =>
  (row: ModlistNode): row is RowOf<K> => kinds.some((kind) => kind === row.kind);

/** The Argument of a gesture the catalog calls singular: the right-clicked row, or the focused row
 *  for a key, when the gesture takes its kind. */
export function singularArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K> | undefined {
  const anchor = entry.clicked ?? entry.focused;
  return anchor !== undefined && isOf(kinds)(anchor) ? anchor : undefined;
}

/** The Argument of a gesture the catalog calls plural: the whole selection, of the kinds it takes.
 *  A selection mixing mods and separators gives only the rows of the right-clicked or focused
 *  row's kind. */
export function pluralArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K>[] {
  const anchor = entry.clicked ?? entry.focused;
  const taken = anchor === undefined ? kinds : kinds.filter((kind) => kind === anchor.kind);
  return entry.selection.filter(isOf(taken));
}
