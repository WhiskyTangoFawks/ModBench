import type { ColumnKey, CompareOverride, ConflictAll, ConflictThis, FieldMetadata, PathSegment } from './types';
import { columnKey } from './types';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

// #272 / ADR-0036: `key` is this column's compound identity, minted once here (buildColumns) via
// columnKey() rather than re-derived at every render/lookup site — every consumer (DiffRow,
// RecordPanel) reads `col.key` instead of `col.override.plugin`/`col.plugin`, which is what makes
// two same-filename columns stop colliding on collapsedColumns/immutableSet/focusedCell/
// overrideMap. `plugin`/`origin` stay present on the `pending` variant (mirroring
// CompareOverride's own plugin+origin fields) only for display/decomposition, never parsed back
// out of `key` itself.
// #410/ADR-0041: one column per override. The pending companion column retired with the model
// that fed it, so this is no longer a union — kept as a discriminated shape anyway (`kind: 'disk'`)
// because DiffRow's own render loop still branches on it and #415 brings a second column kind back.
export type Column = { kind: 'disk'; key: ColumnKey; override: CompareOverride };

export function buildColumns(overrides: CompareOverride[]): Column[] {
  return overrides.map(o => ({ kind: 'disk' as const, key: columnKey(o.plugin, o.origin), override: o }));
}

// #304: the *reason* a column is read-only — `immutableSet` alone (RecordSessionClient.ts) says
// only that it is, which is genuinely ambiguous: a vanilla/DLC master is immutable and still named
// by the load order, while a copy the load order doesn't name (ADR-0036, #34) is immutable
// *because* it isn't. GameSession.AddUnlistedPlugin always sets IsImmutable:true alongside
// InLoadOrder:false, so the two are never independent on the wire today — but a reader that only
// checked isImmutable couldn't tell them apart, and PluginHeader needs to: the tooltip names a
// different cause, and only the second dims (ADR-0035's "non-participating copies render dimmed").
// #415 / ADR-0041: `untracked` joins the two, and is the only one of the three the user can undo —
// "editing requires tracking; viewing never does", and the escape is one command, once, per mod.
export type ReadOnlyReason = 'vanillaMaster' | 'notInLoadOrder' | 'untracked' | null;

/**
 * Why this column cannot be written, or null when it can.
 *
 * Ordered by what the user can do about it, deliberately: the two reasons they cannot fix here come
 * first, so a vanilla master is never told to run Track — a command that does not apply to it and
 * would send them somewhere that leads nowhere. Naming the wrong way out is worse than naming none
 * (AC4: "no silent dead UI" is about dead *ends*, not only about silence).
 *
 * `isTracked` defaults true so a caller that has not learned about tracking yet keeps its
 * pre-#415 answer rather than silently reporting every column as untracked; the record editor,
 * which is the surface that gates on it, always passes it.
 */
export function readOnlyReason(
  isImmutable: boolean, inLoadOrder: boolean, isTracked = true,
): ReadOnlyReason {
  if (isImmutable) return inLoadOrder ? 'vanillaMaster' : 'notInLoadOrder';
  return isTracked ? null : 'untracked';
}

// #304 / ADR-0036: "origin appears inline in the header only when two loaded copies share a
// filename" — computed from the overrides *this* compare response carries (CompareResult.Overrides
// via buildColumns' own input), never the session's whole plugin list. Two CompareOverride rows can
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

// Issue #168 (resurrected #426): the one definition of "does this plugin's own array actually
// have an element at this index" — a row's index comes from the union-aligned tree across every
// plugin's column (an ordinary array with differing per-plugin lengths, or VMAD/Condition's own
// positional alignment), not from this one plugin's own array, so it can be at or past *this
// specific* array's length even though the row itself exists (a sibling plugin has more elements
// there). `length` rather than the array itself so arrayElementContext (which only ever has
// `arrayLength`, no array) can share it too.
export function hasElementAt(length: number, index: number): boolean {
  return index >= 0 && index < length;
}

// Issue #227 (resurrected #426): the three pure array-arity/order mutations behind Move Up/Move
// Down/Remove/Add — shared by the keyboard accelerator (DiskCell's onKeyDown, a pure in-webview
// call) and the right-click menu's broadcast handler (RecordPanel, arriving asynchronously from
// the extension host), so both restage the array identically without needing to share one runtime
// call path. Each returns a new array; callers restage the whole thing via onEditCell, the same
// as any other field commit.
//
// Issue #168: `index` itself must be bounds-checked here, not just the swap target `j` (index ===
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

// Issue #168: bounds-checked the same way moveArrayElement is — `Array.prototype.filter` already
// leaves the *content* unchanged for an out-of-range index, but it still hands back a new array
// reference, which defeats a caller's reference-equality no-op check.
export function removeArrayElement(array: unknown[], index: number): unknown[] {
  if (!hasElementAt(array.length, index)) return array;
  return array.filter((_, i) => i !== index);
}

export function appendArrayElement(array: unknown[], value: unknown): unknown[] {
  return [...array, value];
}

// ── Native right-click menu contexts (issue #227, resurrected #426) ──────────
//
// VS Code's own `contributes.menus["webview/context"]` gates on a `data-vscode-context` attribute
// carrying JSON VS Code parses itself and hands to the invoked command — never a rendered
// `<ul role="menu">`. `combineVscodeContexts` below lets one row carry more than one of these at
// once (a VMAD array-of-scalars property is both an array parent/element and a VMAD structural-op
// target, Track 5), so each builder returns the plain object rather than a JSON string itself.
// The two interfaces themselves live in `src/medit/messages.ts` (imported below), not here —
// extension.ts's own command handlers need the identical shape to type the `ctx` parameter VS
// Code hands them, and that module is the one place both processes already share a contract.
export type { ArrayElementContext, ArrayParentContext, VmadScriptsContext, VmadScriptContext, VmadPropertyContext } from './messages';
import type { ArrayElementContext, ArrayParentContext, VmadScriptsContext, VmadScriptContext, VmadPropertyContext } from './messages';

// Issue #227: DiffRow only attaches this on a mutable column's unsorted-array cell — its mere
// presence is the gate, so no separate immutable/isSortable flag travels in the payload the way
// ColumnHeaderContext's `immutable` once did (Track 5/#427, if that surface returns). `arrayLength`
// only exists to derive canMoveUp/canMoveDown (package.json's `when`-clause gate for Move Up/Move
// Down, mirroring `immutable`'s old role) — Remove has no boundary condition, so `index` alone
// still gates it.
//
// Keyed by `fieldName` = the row's own wire identity (`context.rootField`), not its display label
// — the two only coincide for an ordinary top-level array; a VMAD/Condition array's own wire path
// is a separate string (Track 5's own "wire paths differ" friction).
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, fieldName: string, index: number, arrayLength: number,
): ArrayElementContext {
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, fieldName, index,
    // Issue #168: `canMoveUp` must also check hasElementAt (this plugin's own real length), or
    // the menu offers Move Up on a row this plugin doesn't have an element in at all — canMoveDown
    // doesn't need the same explicit check since index < arrayLength - 1 already implies it.
    canMoveUp: index > 0 && hasElementAt(arrayLength, index), canMoveDown: index < arrayLength - 1,
    preventDefaultContextMenuItems: true,
  };
}

export function arrayParentContext(formKey: string, plugin: string, origin: string, fieldName: string): ArrayParentContext {
  return { webviewSection: 'arrayParent', formKey, plugin, origin, fieldName, preventDefaultContextMenuItems: true };
}

// Issue #231 (resurrected #426 Track 5): same mechanism as arrayElementContext/arrayParentContext
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

// Issue #231 (review): combines every context object sharing one row into the single
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

// Issue #168: shared by VMAD's and Condition's tree adapters (vmadTreeAdapter.ts/
// conditionTreeAdapter.ts) — both align their own array elements positionally across plugins
// (VmadConflictClassifier.IndexedChildren / ConditionConflictClassifier.BuildDiff), and both
// backends report *every* plugin at *every* union-aligned position, null past that plugin's own
// real length (always trailing — a plugin's own list is contiguous, so a null here only ever means
// "this plugin's list ends before this position," never a genuine mid-list hole). Reconstructing
// each plugin's own array must skip those nulls rather than carry them through as literal filler:
// carrying them through was VMAD's actual bug (buildSiblingsByPlugin, pre-#168) — a shorter
// plugin's "current array" ended up padded to the union's length, so a Remove/Move on it restaged
// an array still containing the padding nulls (VmadCodec.RebuildList's `el.GetInt32()`/
// `GetBoolean()`/`GetSingle()` throw on a JSON null element at save time). Condition's own
// equivalent (conditionsSparseByPlugin) already skipped correctly; this is that same logic, shared
// rather than duplicated, so the two can't drift.
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

// ── Conflict aggregation (issue #114) ─────────────────────────────────────────
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

// ── Generic path-based node access (issue #231) ───────────────────────────────
//
// A row's own value can sit at any depth inside the field/wire-path it restages as one atomic
// unit (ADR-0017: an edit anywhere in a struct/array restages the whole thing). `PathSegment[]`
// (defined in types.ts — FieldDiff.commitOverride needs it too, and types.ts is the lower-level
// module of the two) is the chain from that root down to a given row — a struct hop addressed by
// member name, an unsorted-array hop by position, a sorted (pure FormLink) array hop by the
// element's own value (there is nothing to address *beneath* a sortKey hop: a sorted array's
// elements are themselves the value, never a struct/array). getAtPath/setAtPath are the one
// generic implementation every nesting depth shares — the same recursion VmadSection already
// needed for arbitrarily-deep struct/structList members (nodeAt/setNodeValue/removeAt) generalized
// here to the one shared row model instead of staying a VMAD-only duplicate, and replacing
// RecordPanel/DiffRow's old hand-built top-level/array-element/struct-child/grandchild special
// cases (which could not express a fourth level of nesting at all).
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

// #426 (resurrected from before #410): setAtPath's own write-side counterpart — the one generic
// implementation an edit anywhere in a struct/array restages through (ADR-0017: the whole subtree
// is restaged as one atomic value). Never mutates its input: each hop copies its own level before
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

// mirrors VmadSection's defaultElementValue/defaultNode pair, but keyed off the compare grid's
// own FieldMetadata shape rather than VMAD's raw node JSON, which the two do not share.
// The `default` arm is deliberate, not lazy: an unrecognized/future `type` returns '' rather than
// falling through to `undefined`, which would silently append a hole into a saved array.
export function defaultElementValue(meta: FieldMetadata): unknown {
  // Issue #231: an explicit override wins outright — a condition list's own elementType carries
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
    // Issue #231: a VMAD ArrayOfObject's default element — mirrors VmadSection's own
    // defaultElementValue('Object') now that a VMAD array reuses this same generic control.
    case 'vmadObject': return { formKey: '', alias: -1 };
    default: return '';
  }
}
