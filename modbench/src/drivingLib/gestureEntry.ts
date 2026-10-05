import * as vscode from 'vscode';

export interface KindedRow extends vscode.TreeItem {
  readonly kind: string;
}

export type RowOf<Row extends KindedRow, K extends Row['kind']> = Extract<Row, { kind: K }>;

/** The rows a gesture's Argument is taken from. */
export interface GestureEntry<Row extends KindedRow> {
  readonly clicked?: Row;
  readonly focused?: Row;
  readonly selection: readonly Row[];
}

export const kindGuard = <Row extends KindedRow>() =>
  <K extends Row['kind']>(kinds: readonly K[]) =>
    (row: unknown): row is RowOf<Row, K> => row instanceof vscode.TreeItem && 'kind' in row && kinds.some((kind) => kind === row.kind);

// No stable API names the focused row, so from a key or the palette a selection of one row
// stands for it.
export function gestureEntry<Row extends KindedRow>(
  clicked: unknown,
  selected: readonly Row[] | undefined,
  viewSelection: () => readonly Row[],
): GestureEntry<Row> {
  const isRow = (value: unknown): value is Row => value instanceof vscode.TreeItem;
  if (isRow(clicked)) return { clicked, selection: selected ?? [clicked] };
  const selection = viewSelection();
  const [only] = selection;
  return selection.length === 1 && only !== undefined ? { focused: only, selection } : { selection };
}

/** VS Code passes a context menu the right-clicked row, and the selection only when that row is
 *  one of several selected. A key passes its own `args`, and the palette nothing. */
export function registerGesture<Row extends KindedRow>(
  commandId: string,
  viewSelection: () => readonly Row[],
  run: (entry: GestureEntry<Row>, option?: unknown) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, (clicked?: unknown, selected?: readonly Row[], option?: unknown) =>
    run(gestureEntry(clicked, selected, viewSelection), option));
}

/** The Argument of a gesture the catalog calls singular: the right-clicked or focused row, when
 *  the gesture takes its kind. */
export function singularArgument<Row extends KindedRow, K extends Row['kind']>(
  entry: GestureEntry<Row>, ...kinds: K[]
): RowOf<Row, K> | undefined {
  const anchor = entry.clicked ?? entry.focused;
  return anchor !== undefined && kindGuard<Row>()(kinds)(anchor) ? anchor : undefined;
}

/** A gesture's own plural Argument: one kind at a time, so a mixed selection narrows to the
 *  right-clicked or focused row's kind. For the catalog's own plural (commands.md, Argument: "the
 *  whole selection"), use `selectionArgument` instead. */
export function pluralArgument<Row extends KindedRow, K extends Row['kind']>(
  entry: GestureEntry<Row>, ...kinds: K[]
): RowOf<Row, K>[] {
  const anchor = entry.clicked ?? entry.focused;
  const taken = anchor === undefined ? kinds : kinds.filter((kind) => kind === anchor.kind);
  return entry.selection.filter(kindGuard<Row>()(taken));
}

/** The catalog's own plural Argument (commands.md, Argument: "the whole selection"), of the kinds
 *  given: no narrowing to the anchor row's kind, so a mixed selection keeps every kind. */
export function selectionArgument<Row extends KindedRow, K extends Row['kind']>(
  entry: GestureEntry<Row>, ...kinds: K[]
): RowOf<Row, K>[] {
  return entry.selection.filter(kindGuard<Row>()(kinds));
}
