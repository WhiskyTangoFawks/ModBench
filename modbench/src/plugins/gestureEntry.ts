import * as vscode from 'vscode';
import type { PluginsTreeNode } from './PluginsTreeProvider';

/** The rows a Plugins gesture's Argument is taken from. */
export interface GestureEntry {
  readonly clicked?: PluginsTreeNode;
  readonly focused?: PluginsTreeNode;
  readonly selection: readonly PluginsTreeNode[];
}

/** The `args` a Plugins key passes, so a command other surfaces share knows the key is the
 *  Plugins view's. */
export const PLUGINS_KEY_ARGS = { view: 'modbench.pluginListTree' } as const;

export function isPluginsKeyArgs(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'view' in value && value.view === PLUGINS_KEY_ARGS.view;
}

function isRow(value: unknown): value is PluginsTreeNode {
  return value instanceof vscode.TreeItem;
}

// No stable API names the focused row, so from a key or the palette a selection of one row
// stands for it.
export function pluginsGestureEntry(
  clicked: unknown,
  selected: readonly PluginsTreeNode[] | undefined,
  viewSelection: () => readonly PluginsTreeNode[],
): GestureEntry {
  if (isRow(clicked)) return { clicked, selection: selected ?? [clicked] };
  const selection = viewSelection();
  const [only] = selection;
  return selection.length === 1 && only !== undefined ? { focused: only, selection } : { selection };
}

/** VS Code passes a context menu the right-clicked row, and the selection only when that row is
 *  one of several selected. A key passes its own `args`, and the palette nothing. */
export function registerPluginsGesture(
  commandId: string,
  viewSelection: () => readonly PluginsTreeNode[],
  run: (entry: GestureEntry, option?: unknown) => unknown,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    commandId,
    (clicked?: unknown, selected?: readonly PluginsTreeNode[], option?: unknown) =>
      run(pluginsGestureEntry(clicked, selected, viewSelection), option),
  );
}

type ArgumentKind = PluginsTreeNode['kind'];
type RowOf<K extends ArgumentKind> = Extract<PluginsTreeNode, { kind: K }>;

const isOf = <K extends ArgumentKind>(kinds: readonly K[]) =>
  (row: PluginsTreeNode): row is RowOf<K> => kinds.some((kind) => kind === row.kind);

/** The Argument of a gesture the catalog calls singular: the right-clicked or focused row, when
 *  the gesture takes its kind. */
export function singularArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K> | undefined {
  const anchor = entry.clicked ?? entry.focused;
  return anchor !== undefined && isOf(kinds)(anchor) ? anchor : undefined;
}

/** A gesture's own Argument: one kind at a time, so a mixed selection narrows to the right-
 *  clicked or focused row's kind. For the catalog's own plural (commands.md, Argument: "the whole
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
