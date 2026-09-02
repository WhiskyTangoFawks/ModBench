import type { ColumnKey, CompareOverride, ConflictAll, ConflictThis, FieldMetadata, PathSegment } from './types';
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

// The *reason* a column is read-only — `immutableSet` alone (RecordPanelClient.ts) says
// only that it is, which is genuinely ambiguous: a vanilla/DLC master is immutable and still named
// by the load order, while a copy the load order doesn't name (ADR-0036) is immutable
// *because* it isn't. a losing copy's registration derives IsImmutable:true alongside
// InLoadOrder:false, so the two are never independent on the wire today — but a reader that only
// checked isImmutable couldn't tell them apart, and PluginHeader needs to: the tooltip names a
// different cause, and only the second dims (ADR-0035's "non-participating copies render dimmed").
// ADR-0041: `untracked` is the only one of the three the user can undo —
// "editing requires tracking; viewing never does", and the escape is one command, once, per mod.
export type ReadOnlyReason = 'vanillaMaster' | 'notInLoadOrder' | 'untracked' | null;

/**
 * Why this column cannot be written, or null when it can.
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
export function readOnlyReason(
  isImmutable: boolean, inLoadOrder: boolean, isTracked = true,
): ReadOnlyReason {
  if (isImmutable) return inLoadOrder ? 'vanillaMaster' : 'notInLoadOrder';
  return isTracked ? null : 'untracked';
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

// The one definition of "does this plugin's own array actually
// have an element at this index" — a row's index comes from the union-aligned tree across every
// plugin's column (an ordinary array with differing per-plugin lengths, or VMAD/Condition's own
// positional alignment), not from this one plugin's own array, so it can be at or past *this
// specific* array's length even though the row itself exists (a sibling plugin has more elements
// there). `length` rather than the array itself so arrayElementContext (which only ever has
// `arrayLength`, no array) can share it too.
export function hasElementAt(length: number, index: number): boolean {
  return index >= 0 && index < length;
}

// #630: the three pure array-arity/order mutations behind Move Up/Move Down/Remove/Add — for an
// ordinary reflected field these moved server-side (RecordFieldWriter/ArrayOpWriter compute the
// result from the record's own current value and schema); the surviving callers are
// RecordPanel's own VMAD and Condition carve-outs (both routed through computeArrayOpClientSide),
// each deliberately out of #630's scope — a Papyrus scalar-array property's own arity ops belong
// in VmadCodec's own structural-op vocabulary, a Condition-owning field's in
// Fallout4ConditionCodec's (ApplyListValue requires a JSON array and refuses an op-envelope object
// the same way VMAD's own path dispatch does) — neither is ArrayOpWriter's ColumnSpec-backed one.
// Each returns a new array; the carve-out commits the whole thing via onEditCell, the same as any
// other field commit.
//
// `index` itself must be bounds-checked here, not just the swap target `j` (index ===
// array.length, direction -1 → j = index - 1, which passes a j-only guard) — without it, the
// destructuring swap extends the array by one slot and duplicates a value instead of the "return
// the array unchanged" no-op every other boundary already gets.
export function moveArrayElement(array: unknown[], index: number, direction: -1 | 1): unknown[] {
  const j = index + direction;
  if (!hasElementAt(array.length, index) || !hasElementAt(array.length, j)) return array;
  const next = [...array];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

// Bounds-checked the same way moveArrayElement is — `Array.prototype.filter` already
// leaves the *content* unchanged for an out-of-range index, but it still hands back a new array
// reference, which defeats a caller's reference-equality no-op check.
export function removeArrayElement(array: unknown[], index: number): unknown[] {
  if (!hasElementAt(array.length, index)) return array;
  return array.filter((_, i) => i !== index);
}

export function appendArrayElement(array: unknown[], value: unknown): unknown[] {
  return [...array, value];
}

// ── Native right-click menu contexts ──────────────────────────────────────────
//
// VS Code's own `contributes.menus["webview/context"]` gates on a `data-vscode-context` attribute
// carrying JSON VS Code parses itself and hands to the invoked command — never a rendered
// `<ul role="menu">`. `combineVscodeContexts` below lets one row carry more than one of these at
// once (a VMAD array-of-scalars property is both an array parent/element and a VMAD structural-op
// target), so each builder returns the plain object rather than a JSON string itself.
// The two interfaces themselves live in `src/medit/messages.ts` (imported below), not here —
// extension.ts's own command handlers need the identical shape to type the `ctx` parameter VS
// Code hands them, and that module is the one place both processes already share a contract.
export type {
  ArrayElementContext, ArrayParentContext, VmadScriptsContext, VmadScriptContext, VmadPropertyContext, ColumnHeaderContext,
  StringValueContext,
} from './messages';
import type {
  ArrayElementContext, ArrayParentContext, VmadScriptsContext, VmadScriptContext, VmadPropertyContext, ColumnHeaderContext,
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
// above, carried by VMAD's own row kinds instead — see VmadScriptsContext/VmadScriptContext/
// VmadPropertyContext's own doc comment (messages.ts) for why no extra identity travels beyond
// script/property name.
export function vmadScriptsContext(formKey: string, plugin: string, origin: string): VmadScriptsContext {
  return { webviewSection: 'vmadScripts', formKey, plugin, origin, preventDefaultContextMenuItems: true };
}

export function vmadScriptContext(
  formKey: string, plugin: string, origin: string, scriptName: string, currentFlags: string | null,
): VmadScriptContext {
  return { webviewSection: 'vmadScript', formKey, plugin, origin, scriptName, currentFlags, preventDefaultContextMenuItems: true };
}

export function vmadPropertyContext(
  formKey: string, plugin: string, origin: string, scriptName: string, propName: string,
): VmadPropertyContext {
  return {
    webviewSection: 'vmadProperty', formKey, plugin, origin, scriptName, propName, preventDefaultContextMenuItems: true,
  };
}

// The record editor's column header — Copy as Override Into…/Copy as New Record
// Into… as native `webview/context` entries, the same mechanism every other row-level menu
// here already uses. No mutable/immutable/tracked gating baked in here: the column's own
// read-only-ness is irrelevant to whether it can be a *source* — copying from a vanilla master is
// the headline case — so every column carries this context unconditionally.
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
// for its own array/VMAD contexts), so a save from the extended editor reaches RecordPanel's
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

// Shared by VMAD's and Condition's tree adapters (vmadTreeAdapter.ts/
// conditionTreeAdapter.ts) — both align their own array elements positionally across plugins
// (VmadConflictClassifier.IndexedChildren / ConditionConflictClassifier.BuildDiff), and both
// backends report *every* plugin at *every* union-aligned position, null past that plugin's own
// real length (always trailing — a plugin's own list is contiguous, so a null here only ever means
// "this plugin's list ends before this position," never a genuine mid-list hole). Reconstructing
// each plugin's own array must skip those nulls rather than carry them through as literal filler:
// otherwise a shorter
// plugin's "current array" ends up padded to the union's length, so a Remove/Move on it restages
// an array still containing the padding nulls (VmadCodec.RebuildList's `el.GetInt32()`/
// `GetBoolean()`/`GetSingle()` throw on a JSON null element at save time). Shared
// rather than duplicated across the two adapters, so they can't drift.
export function sparseArrayByPlugin<T>(perPositionValues: Record<string, T | null>[]): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const [i, values] of perPositionValues.entries()) {
    for (const [plugin, value] of Object.entries(values)) {
      if (value == null) continue;
      if (!result[plugin]) result[plugin] = [];
      result[plugin][i] = value;
    }
  }
  return result;
}

// ── Conflict aggregation ──────────────────────────────────────────────────────
//
// The compare grid colors each row from its own FieldDiff.conflictAll (DiffRow), not a
// record-wide value smeared across every row. The backend computes it for an ordinary reflected
// field (MEditService.Core/Queries/ConflictClassifier.cs's AggregateConflictAll); VMAD/Condition
// rows are synthesized entirely on the frontend (vmadTreeAdapter.ts/conditionTreeAdapter.ts) from
// their own backend DTOs (VmadPropertyDiff/ConditionDiff), which carry no such field themselves —
// so those two adapters compute it here, at every node they build, using the identical rule the
// backend applies. Kept in sync by design (same rule, mirrored by hand across the two languages),
// not by shared code — there is no cross-language module to share.

// Mirrors ConflictRules.Reduce: folds a set of per-plugin ConflictThis cell states into the
// ConflictAll they imply — any ConflictWins/ConflictLoses => Conflict; else any Override =>
// Override; else NoConflict. Never produces OnlyOne/ConflictCritical — those are record-wide-only
// terminal states (the Plugins-tree badge), which no per-node value ever needs to express.
export function reduceConflictAll(states: ConflictThis[]): ConflictAll {
  let hasConflict = false;
  let hasOverride = false;
  for (const state of states) {
    if (state === 'ConflictWins' || state === 'ConflictLoses') hasConflict = true;
    else if (state === 'Override') hasOverride = true;
  }
  if (hasConflict) return 'Conflict';
  if (hasOverride) return 'Override';
  return 'NoConflict';
}

// OnlyOne/ConflictCritical are included only so this satisfies TS's Record<ConflictAll, number>
// exhaustiveness check — reduceConflictAll/aggregateConflictAll never produce or compare against
// them (both are record-wide-only terminal states), so their severity numbers are never read.
const CONFLICT_ALL_SEVERITY: Record<ConflictAll, number> = {
  NoConflict: 0, Override: 1, Conflict: 2, OnlyOne: 3, ConflictCritical: 3,
};

// A node's own bottom-up conflictAll: its own cellStates reduced, then folded with each
// already-built child's own (already-aggregated) conflictAll via "worst of two" — mirrors
// ConflictRules.Escalate, restricted to the three non-terminal states this ever sees.
export function aggregateConflictAll(
  ownCellStates: Record<string, ConflictThis>,
  children?: ({ conflictAll?: ConflictAll } | undefined)[] | null,
): ConflictAll {
  let result = reduceConflictAll(Object.values(ownCellStates));
  for (const child of children ?? []) {
    if (child?.conflictAll && CONFLICT_ALL_SEVERITY[child.conflictAll] > CONFLICT_ALL_SEVERITY[result]) {
      result = child.conflictAll;
    }
  }
  return result;
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
// still needed by the array-op broadcast handler (RecordPanel.tsx) for its own VMAD/Condition
// carve-outs ('add' on either needs an element schema to default from), which has only
// the wire's rootField/path to work with, never a render-time `context.overrideMeta` the way DiffRow's own
// buildRows resolves a row's meta by hand (member → `.fields`, index/sortKey → `.elementType`,
// the same two hops this mirrors). Reading `fieldMetaMap[rootField].elementType` directly
// would only find the right element type when the array itself is the subtree root —
// for a *nested* array it would name the wrong node's (or, off a struct root, no) elementType, and
// defaultElementValue would build a malformed added element from the fallback.
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

// Keyed off the compare grid's
// own FieldMetadata shape rather than VMAD's raw node JSON, which the two do not share.
// The `default` arm is deliberate, not lazy: an unrecognized/future `type` returns '' rather than
// falling through to `undefined`, which would silently append a hole into a saved array.
export function defaultElementValue(meta: FieldMetadata): unknown {
  // An explicit override wins outright — a condition list's own elementType carries
  // one (a real `ParsedCondition`, since its wire shape doesn't match this function's generic
  // per-display-field-name struct default). Absent for every ordinary/VMAD elementType.
  if (meta.defaultValue !== undefined) return structuredClone(meta.defaultValue);
  switch (meta.type) {
    case 'string': case 'formKey': return '';
    case 'int': case 'float': return 0;
    case 'bool': return false;
    case 'enum': return meta.enumValues[0] ?? '';
    case 'struct': return Object.fromEntries((meta.fields ?? []).map(f => [f.name, defaultElementValue(f)]));
    case 'array': return [];
    // A VMAD ArrayOfObject's default element.
    case 'vmadObject': return { formKey: '', alias: -1 };
    default: return '';
  }
}
