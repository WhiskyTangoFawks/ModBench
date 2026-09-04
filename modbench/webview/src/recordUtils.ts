import type { ColumnKey, CompareOverride, FieldMetadata, PathSegment } from './types';
import { columnKey } from './types';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

// ADR-0036: `key` is this column's compound identity, minted once here (buildColumns) via
// columnKey() rather than re-derived at every render/lookup site — every consumer (DiffRow,
// RecordPanel) reads `col.key` instead of `col.override.plugin`/`col.plugin`, which is what makes
// two same-filename columns stop colliding on collapsedColumns/immutableSet/focusedCell/
// overrideMap. `plugin`/`origin` stay present on the overlay variant (mirroring
// CompareOverride's own plugin+origin fields) only for display/decomposition, never parsed back
// out of `key` itself.
// ADR-0041/ADR-0019: one column per override — the record's full in-game resolution stack,
// restored by the #618 follow-up (the collapse-to-winner over-reached the ruling; ADR-0036
// amended: file-level losers are excluded by the backend before they reach this list).
// Kept as a discriminated shape (`kind: 'disk'`) even though there is currently only one kind —
// DiffRow's own render loop branches on it.
export type Column = { kind: 'disk'; key: ColumnKey; override: CompareOverride };

// xEdit's own layout: load order ascending, master leftmost, winner rightmost — the wire order
// itself (GetOverrideStack's ORDER BY load_order_idx), trusted rather than re-sorted here.
export function buildColumns(overrides: CompareOverride[]): Column[] {
  return overrides.map(o => ({ kind: 'disk' as const, key: columnKey(o.plugin, o.origin), override: o }));
}

// Every column carries exactly one of these, always shown (PluginHeader) — never a silent
// fourth "nothing to say" case, which used to read as a defect ("did my Track even work?") rather
// than as the writable state it was. `immutableSet` alone (RecordPanelClient.ts) says only that a
// column is immutable, which is genuinely ambiguous: a vanilla/DLC master is immutable and still
// named by the load order, while a copy the load order doesn't name (ADR-0036) is immutable
// *because* it isn't. A losing copy's registration derives IsImmutable:true alongside
// InLoadOrder:false, so the two are never independent on the wire today — but a reader that only
// checked isImmutable couldn't tell them apart, and PluginHeader needs to: the tooltip names a
// different cause, and only the second dims (ADR-0035's "non-participating copies render dimmed").
// ADR-0041: `untracked` is the only one of the four the user can undo —
// "editing requires tracking; viewing never does", and the escape is one command, once, per mod.
export type ColumnStatus = 'vanillaMaster' | 'notInLoadOrder' | 'untracked' | 'tracked';

/**
 * This column's status, for PluginHeader's own label — always exactly one of the four, never
 * absent.
 *
 * Ordered by what the user can do about it, deliberately: the two reasons they cannot fix here come
 * first, so a vanilla master is never told to run Track — a command that does not apply to it and
 * would send them somewhere that leads nowhere. Naming the wrong way out is worse than naming none
 * ("no silent dead UI" is about dead *ends*, not only about silence).
 *
 * `isTracked` defaults true so a caller that does not pass it
 * is not silently reporting every column as untracked; the record editor,
 * which is the surface that gates on it, always passes it.
 */
export function columnStatus(
  isImmutable: boolean, inLoadOrder: boolean, isTracked = true,
): ColumnStatus {
  if (isImmutable) return inLoadOrder ? 'vanillaMaster' : 'notInLoadOrder';
  return isTracked ? 'tracked' : 'untracked';
}

// ADR-0036: "origin appears inline in the header only when two loaded copies share a
// filename" — computed from the overrides *this* compare response carries (CompareResult.Overrides
// via buildColumns' own input), never the load order's whole plugin list. Two CompareOverride rows can
// never share both plugin and origin (the backend's own (form_key, origin, plugin) key), so any
// filename counted more than once here is necessarily two genuinely distinct loaded copies.
export function collidingFilenames(overrides: CompareOverride[]): Set<string> {
  const counts = new Map<string, number>();
  for (const o of overrides) counts.set(o.plugin, (counts.get(o.plugin) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([plugin]) => plugin));
}

// ── Array child helpers ───────────────────────────────────────────────────────

export function parseElementIndex(fieldName: string): number {
  return Number.parseInt(fieldName.slice(1, -1), 10);
}

// The one definition of "does this plugin's own array actually have an element at this index" — a
// row's index comes from the union-aligned tree across every plugin's column (an array with
// differing per-plugin lengths), not from this one plugin's own array, so it can be at or past
// *this specific* array's length even though the row itself exists (a sibling plugin has more
// elements there). `length` rather than the array itself so arrayElementContext (which only ever
// has `arrayLength`, no array) can share it too.
export function hasElementAt(length: number, index: number): boolean {
  return index >= 0 && index < length;
}

// ── Native right-click menu contexts ──────────────────────────────────────────
//
// VS Code's own `contributes.menus["webview/context"]` gates on a `data-vscode-context` attribute
// carrying JSON VS Code parses itself and hands to the invoked command — never a rendered
// `<ul role="menu">`. `combineVscodeContexts` below lets one row carry more than one of these at
// once (an array element row is both an element and, through its parent, part of that array), so
// each builder returns the plain object rather than a JSON string itself.
// The two interfaces themselves live in `src/medit/messages.ts` (imported below), not here —
// extension.ts's own command handlers need the identical shape to type the `ctx` parameter VS
// Code hands them, and that module is the one place both processes already share a contract.
export type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext,
  StringValueContext,
} from './messages';
import type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext,
  StringValueContext,
} from './messages';

// DiffRow only attaches this on a mutable column's unsorted-array cell — its mere
// presence is the gate, so no separate immutable/isSortable flag travels in the payload.
// `arrayLength`
// only exists to derive canMoveUp/canMoveDown (package.json's `when`-clause gate for Move Up/Move
// Down) — Remove has no boundary condition, so the last path
// segment's index alone still gates it.
//
// `path` is the row's own restage coordinates (RowContext, DiffRow.tsx) — the element's full
// chain of hops from the subtree root, never a bare scalar index (a top-level array's
// element is a one-hop path, but a nested array's element needs every hop, which a scalar
// index could never carry).
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, rootField: string, path: PathSegment[], arrayLength: number,
): ArrayElementContext {
  const lastSeg = path[path.length - 1];
  const index = lastSeg?.kind === 'index' ? lastSeg.index : -1;
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, rootField, path,
    // `canMoveUp` must also check hasElementAt (this plugin's own real length), or
    // the menu offers Move Up on a row this plugin doesn't have an element in at all — canMoveDown
    // doesn't need the same explicit check since index < arrayLength - 1 already implies it.
    canMoveUp: index > 0 && hasElementAt(arrayLength, index), canMoveDown: index < arrayLength - 1,
    preventDefaultContextMenuItems: true,
  };
}

// `path` addresses the array itself (the row's own path when it *is* the array — a top-level
// array's is `[]`).
export function arrayParentContext(
  formKey: string, plugin: string, origin: string, rootField: string, path: PathSegment[],
): ArrayParentContext {
  return { webviewSection: 'arrayParent', formKey, plugin, origin, rootField, path, preventDefaultContextMenuItems: true };
}

// Same mechanism as arrayElementContext/arrayParentContext
export function headerCellContext(formKey: string, plugin: string, origin: string): ColumnHeaderContext {
  return { webviewSection: 'recordHeader', formKey, plugin, origin, preventDefaultContextMenuItems: true };
}

// ADR-0039: a `string` value cell's own right-click entry — the extended editor's only
// trigger, since no left-click gesture may reach it. Offered unconditionally on every string leaf
// cell in the field grid, mutable or immutable alike — `readOnly` is what the command's own
// `when` clause (and the tab it opens) act on, not the cell's mere presence here. `value` is the
// cell's own current model value (DiffRow already computes this identically for display/copy), so
// the extension host never needs to re-derive it.
//
// `path`/`rootField` are the row's own restage coordinates (RowContext, DiffRow.tsx) — both
// already in scope at every call site (DiffRow already builds `context.path`/`context.rootField`
// for its own array contexts), so a save from the extended editor reaches RecordPanel's
// whole-field reconstruction (handleCellCommit, the same one an inline edit
// goes through) instead of committing the saved text alone under `rootField`.
export function stringValueContext(
  formKey: string, plugin: string, origin: string, fieldName: string, value: string, readOnly: boolean,
  path: PathSegment[], rootField: string,
): StringValueContext {
  return {
    webviewSection: 'stringValue', formKey, plugin, origin, fieldName, value, readOnly, path, rootField,
    preventDefaultContextMenuItems: true,
  };
}

// Combines every context object sharing one row into the single
// `data-vscode-context` string that element actually carries — VS Code's own `webviewSection` key
// supports a space-separated multi-token value via the `=~` regex `when`-clause operator, so this
// becomes the union of every context's own token, and every command's `package.json` `when`
// clause matches its own with `=~ /\btoken\b/`. Every other key merges in directly — they're
// always equal across contexts sharing one row, so last-write-wins is harmless.
export function combineVscodeContexts(...contexts: (object | undefined)[]): string | undefined {
  const present = contexts.filter((c): c is Record<string, unknown> => c != null);
  if (present.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  const sections: string[] = [];
  for (const c of present) {
    const { webviewSection, ...rest } = c;
    if (typeof webviewSection === 'string') sections.push(webviewSection);
    Object.assign(merged, rest);
  }
  return JSON.stringify({ ...merged, webviewSection: sections.join(' ') });
}

// ── Generic path-based node access ────────────────────────────────────────────
//
// A row's own value can sit at any depth inside the field/wire-path it writes as one atomic
// unit (a complex field is always written as one atomic unit, CONTEXT.md — an edit anywhere in a
// struct/array writes the whole thing). `PathSegment[]`
// (defined in src/medit/messages.ts — StringValueContext/FIELD_OPEN_EXTENDED_EDITOR need it
// too, and that module is the one the extension host already imports directly; re-exported from
// types.ts, which re-exports it here) is the chain from that root down to a given row — a struct
// hop addressed by member name, an unsorted-array hop by position, a sorted (pure FormLink) array
// hop by the element's own value (there is nothing to address *beneath* a sortKey hop: a sorted
// array's elements are themselves the value, never a struct/array). getAtPath/setAtPath are the one
// generic implementation every nesting depth shares.
export type { PathSegment };

export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (seg.kind === 'member') cur = (cur as Record<string, unknown> | undefined)?.[seg.name];
    else if (seg.kind === 'index') cur = Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined;
    else cur = seg.key;
  }
  return cur;
}

// getAtPath's write-side counterpart — the one generic
// implementation an edit anywhere in a struct/array writes through (ADR-0041: the whole subtree
// commits as one atomic source write). Never mutates its input: each hop copies its own level before
// recursing, so a caller can compare the result against the original root by reference.
export function setAtPath(root: unknown, path: readonly PathSegment[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [seg, ...rest] = path;
  if (seg.kind === 'member') {
    const obj: Record<string, unknown> = { ...(root as Record<string, unknown> | undefined) };
    obj[seg.name] = setAtPath(obj[seg.name], rest, value);
    return obj;
  }
  if (seg.kind === 'index') {
    const arr = Array.isArray(root) ? [...(root as unknown[])] : [];
    arr[seg.index] = setAtPath(arr[seg.index], rest, value);
    return arr;
  }
  // sortKey: always the final segment (see the module doc comment) — replace the element whose
  // current value matches the segment's own key.
  const arr = Array.isArray(root) ? [...(root as unknown[])] : [];
  return arr.map(e => (e === seg.key ? value : e));
}

// getAtPath/setAtPath's metadata-side counterpart, over FieldMetadata instead of a value — #630:
// used by the presentation table (presentation.ts) and the string cell's extended-editor commit,
// which have only the wire's rootField/path to work with, never a render-time
// `context.overrideMeta` the way DiffRow's own buildRows resolves a row's meta by hand (member →
// `.fields`, index/sortKey → `.elementType`, the same two hops this mirrors). Reading
// `fieldMetaMap[rootField].elementType` directly would only find the right element type when the
// array itself is the subtree root — for a *nested* array it would name the wrong node's (or, off
// a struct root, no) elementType.
// `?? undefined` on the way out: the wire's `elementType`/`fields` are `T | null` (a genuinely
// absent element schema), while every caller here treats "no metadata" as `undefined`. Collapsing
// the two at this one boundary keeps the null out of the callers rather than widening each of them.
export function metaAtPath(meta: FieldMetadata | undefined, path: readonly PathSegment[]): FieldMetadata | undefined {
  let cur: FieldMetadata | null | undefined = meta;
  for (const seg of path) {
    if (!cur) return undefined;
    cur = seg.kind === 'member' ? cur.fields?.find(f => f.name === seg.name) : cur.elementType;
  }
  return cur ?? undefined;
}

