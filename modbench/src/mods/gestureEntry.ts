import * as vscode from 'vscode';
import { OVERWRITE_ORIGIN } from '../instanceLoader/loadOrderSnapshot';
import type { ModlistNode, ModNode, OverwriteNode, SeparatorNode } from './ModListProvider';
import type { FileNode, FolderNode } from './modFiles';

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

type ArgumentRow = ModNode | SeparatorNode | OverwriteNode | FolderNode | FileNode;
type ArgumentKind = ArgumentRow['kind'];
export type RowOf<K extends ArgumentKind> = Extract<ArgumentRow, { kind: K }>;

export const isRowOf = <K extends ArgumentKind>(kinds: readonly K[]) =>
  (row: unknown): row is RowOf<K> => isRow(row) && kinds.some((kind) => kind === row.kind);

/** The Argument of a gesture the catalog calls singular: the right-clicked or focused row, when
 *  the gesture takes its kind. */
export function singularArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K> | undefined {
  const anchor = entry.clicked ?? entry.focused;
  return anchor !== undefined && isRowOf(kinds)(anchor) ? anchor : undefined;
}

const OPEN_FOLDER_KINDS = ['mod', OVERWRITE_ORIGIN, 'folder', 'file'] as const;

export const openFolderArgument = (entry: GestureEntry) => singularArgument(entry, ...OPEN_FOLDER_KINDS);

/** Move's own Argument: one kind at a time, so a mixed selection narrows to the right-clicked or
 *  focused row's kind. For the catalog's own plural (commands.md, Argument: "the whole
 *  selection"), use `selectionArgument` instead. */
export function pluralArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K>[] {
  const anchor = entry.clicked ?? entry.focused;
  const taken = anchor === undefined ? kinds : kinds.filter((kind) => kind === anchor.kind);
  return entry.selection.filter(isRowOf(taken));
}

/** The catalog's own plural Argument (commands.md, Argument: "the whole selection"), of the kinds
 *  given: no narrowing to the anchor row's kind, so a mixed selection keeps every kind. */
export function selectionArgument<K extends ArgumentKind>(entry: GestureEntry, ...kinds: K[]): RowOf<K>[] {
  return entry.selection.filter(isRowOf(kinds));
}

/** What the Mods keys' and palette entries' `when` clauses read off the selection, since neither
 *  is handed a row. */
export interface ModsKeyContext {
  readonly selectionToggle?: 'enable' | 'disable';
  readonly selectionKind?: ArgumentKind;
  readonly singleRow: boolean;
  /** One row, and open folder takes it. */
  readonly singleOpenFolderRow: boolean;
  /** One row, and a file in a file order conflict. */
  readonly singleGoToModRow: boolean;
  /** One row, and a file that loses its file order conflict. */
  readonly singleCompareFileRow: boolean;
  /** One row, and a mod with a file order conflict. */
  readonly singleOpenConflictsRow: boolean;
  readonly holdsEnabledMod: boolean;
  readonly holdsDisabledMod: boolean;
  readonly holdsUntrackedModWithPlugin: boolean;
  readonly holdsIncludedFile: boolean;
  readonly holdsExcludedFile: boolean;
}

export function modsKeyContext(selection: readonly ModlistNode[], isEnabled: (row: ModNode) => boolean): ModsKeyContext {
  const mods = selection.filter(isRowOf(['mod']));
  const files = selection.filter(isRowOf(['file']));
  // No API names the focused row, and a file or folder in the selection may be it: the keys do
  // nothing on one (mods.md, Menus and keys, story 8).
  const keyed = selection.some(isRowOf(['folder', 'file'])) ? [] : selection;
  const [firstMod] = keyed.filter(isRowOf(['mod']));
  const kinds = new Set(keyed.filter(isRowOf(['mod', 'separator'])).map((row) => row.kind));
  const [onlyKind] = kinds;
  const [onlyRow] = selection.length === 1 ? selection : [];
  return {
    selectionToggle: firstMod && toggleOf(isEnabled(firstMod)),
    selectionKind: kinds.size === 1 ? onlyKind : undefined,
    singleRow: onlyRow !== undefined,
    singleOpenFolderRow: openFolderArgument({ focused: onlyRow, selection }) !== undefined,
    singleGoToModRow: onlyRow?.kind === 'file' && onlyRow.inConflict,
    singleCompareFileRow: onlyRow?.kind === 'file' && onlyRow.losesConflict,
    singleOpenConflictsRow: onlyRow?.kind === 'mod' && onlyRow.facts?.fileOrderConflict === true,
    holdsEnabledMod: mods.some(isEnabled),
    holdsDisabledMod: mods.some((row) => !isEnabled(row)),
    holdsUntrackedModWithPlugin: mods.some((row) => row.facts?.holdsPlugin === true && !row.facts.tracked),
    holdsIncludedFile: files.some((row) => row.exclusion === 'included'),
    holdsExcludedFile: files.some((row) => row.exclusion === 'excluded'),
  };
}

function toggleOf(enabled: boolean): 'enable' | 'disable' {
  return enabled ? 'disable' : 'enable';
}
