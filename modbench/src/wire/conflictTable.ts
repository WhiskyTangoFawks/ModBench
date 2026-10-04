// mods-conflicts.md: the conflict table as Mods builds it, and the messages between the extension
// and the table's webview.

import type { components } from './generated/api';

/** Whose copies a column holds: a mod, by its name, or Overwrite, which a mod's name never names
 *  (ADR-0012). */
export type ConflictOrigin = { readonly kind: 'mod'; readonly name: string } | { readonly kind: 'runtimeOutput' };

export type ConflictCellState = Exclude<components['schemas']['ConflictThis'], 'OnlyOne'>;
export type ConflictRowState = Exclude<components['schemas']['ConflictAll'], 'OnlyOne'>;

export interface ConflictColumn {
  readonly name: string;
  readonly origin: ConflictOrigin;
  readonly opened: boolean;
  /** The worst state among the column's cells; null when none has one. */
  readonly state: ConflictCellState | null;
}

/** One mod's copy of one file. `state` is null where it is not known: the copy could not be read
 *  (`unreadable` says why), or the copies' answer has not landed. */
export interface ConflictCell {
  readonly state: ConflictCellState | null;
  readonly unreadable?: string;
}

/** A cell for each column, in column order; null where the column's mod has no copy. */
export type ConflictRow =
  | {
    readonly kind: 'folder'; readonly name: string; readonly path: string; readonly rows: readonly ConflictRow[];
    /** The worst state beneath it. */
    readonly state: ConflictRowState | null;
  }
  | {
    readonly kind: 'file'; readonly name: string; readonly path: string; readonly cells: readonly (ConflictCell | null)[];
    readonly state: ConflictRowState | null;
  };

/** The table, or the message shown in its place. */
export type ConflictTable =
  | { readonly kind: 'table'; readonly columns: readonly ConflictColumn[]; readonly rows: readonly ConflictRow[] }
  | { readonly kind: 'message'; readonly text: string };

export const CONFLICT_TABLE_SHOWN = 'conflictTableShown';
// The webview's listener exists only once its script has run, so the host answers this rather
// than posting into a page that cannot hear it.
export const CONFLICT_TABLE_READY = 'conflictTableReady';

export interface ConflictTableShown {
  readonly type: typeof CONFLICT_TABLE_SHOWN;
  readonly table: ConflictTable;
  /** The message line above the table: the last read behind it failed. */
  readonly notice?: string;
}

export interface ConflictTableReady {
  readonly type: typeof CONFLICT_TABLE_READY;
}

// A `data-vscode-context` payload VS Code hands the invoked command.
export interface ConflictColumnContext {
  readonly webviewSection: 'conflictColumn';
  readonly mod: string;
  readonly preventDefaultContextMenuItems: true;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

// Shallow: the table is the host's own build, trusted once the envelope checks out.
function isConflictTable(value: unknown): value is ConflictTable {
  return isObject(value) && (Reflect.get(value, 'kind') === 'table' || Reflect.get(value, 'kind') === 'message');
}

export function parseConflictTableShown(value: unknown): ConflictTableShown | undefined {
  if (!isObject(value) || Reflect.get(value, 'type') !== CONFLICT_TABLE_SHOWN) return undefined;
  const table: unknown = Reflect.get(value, 'table');
  const notice: unknown = Reflect.get(value, 'notice');
  if (!isConflictTable(table)) return undefined;
  return typeof notice === 'string' ? { type: CONFLICT_TABLE_SHOWN, table, notice } : { type: CONFLICT_TABLE_SHOWN, table };
}

export const isConflictTableReady = (value: unknown): boolean =>
  isObject(value) && Reflect.get(value, 'type') === CONFLICT_TABLE_READY;

/** The mod a column header's context names. */
export function modOfConflictColumn(value: unknown): string | undefined {
  if (!isObject(value) || Reflect.get(value, 'webviewSection') !== 'conflictColumn') return undefined;
  const mod: unknown = Reflect.get(value, 'mod');
  return typeof mod === 'string' ? mod : undefined;
}
