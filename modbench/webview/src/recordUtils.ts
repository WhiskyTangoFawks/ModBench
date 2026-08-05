import type { CompareOverride, FieldMetadata, PathSegment, RecordDetail } from './types';
import type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext, PendingCellContext,
  VmadScriptsContext, VmadScriptContext, VmadPropertyContext,
} from './messages';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? '';
}

// Issue #208: the pending cell's right-click menu (Reveal in Pending Changes Tree / Save Group /
// Revert Group) is VS Code's own `contributes.menus["webview/context"]` now, not a hand-drawn
// `<ul role="menu">`. `webviewSection` is the gating key every menu entry's `when` clause checks
// (alongside VS Code's own `webviewId`, which equals the view type passed to
// `createWebviewPanel` — 'modbench'); `changeId` is forwarded to the invoked command as part of
// the merged context object. `preventDefaultContextMenuItems` suppresses the built-in Cut/Copy/
// Paste entries. Shared by every render site that owns a pending cell (DiffRow, VmadSection x3,
// ConditionSection) so the shape can't drift between them — the cell must NOT also call
// `e.preventDefault()` on the contextmenu event, or VS Code's webview preload bails and the
// native menu never opens (that omission is the actual migration switch, site by site).
export function pendingCellContext(changeId: string): string {
  return JSON.stringify({
    webviewSection: 'pendingCell', changeId, preventDefaultContextMenuItems: true,
  } satisfies PendingCellContext);
}

// Issue #86: the header record's "masters" field, pending-aware (a still-unsaved Add Master
// already counts as current — matches the backend's CheckMasterEdit baseline convention).
// Moved here from PluginHeader.tsx in #209: RecordPanel now needs it too, to build the column
// header's data-vscode-context (below) and to compute the appended list when the native Add
// Master command's broadcast comes back in.
export function currentMasters(o: RecordDetail): string[] {
  const disk = o.fields.find(f => f.metadata.name === 'masters')?.value;
  const pending = o.pendingFields?.masters;
  const value = Array.isArray(pending) ? pending : disk;
  return Array.isArray(value) ? value as string[] : [];
}

// Issue #209: the column-header right-click menu (Copy All to Pending / Copy as New Record /
// Copy as Override… / Remove / Add Master) is native now too — same mechanism as
// pendingCellContext above, carried by the header `<th>` instead of a pending cell. `plugin` is
// this column's own plugin (the copy actions' exclude-from-target-picker source; Remove's
// direct target); `masters` backs the Add Master command's candidate list without a round trip
// back into the webview to ask (see ColumnHeaderContext's own doc comment for why that list is
// NOT filtered to mutable plugins the way the copy actions' picker is).
export function columnHeaderContext(
  formKey: string, plugin: string, immutable: boolean, isHeaderRecord: boolean, masters: string[],
): string {
  return JSON.stringify({
    webviewSection: 'columnHeader', formKey, plugin, immutable, isHeaderRecord, masters,
    preventDefaultContextMenuItems: true,
  } satisfies ColumnHeaderContext);
}

// Issue #227: the array-element/array-parent right-click menu's data-vscode-context, same
// mechanism as pendingCellContext/columnHeaderContext above. DiffRow only attaches this on a
// mutable column's unsorted-array cell (mirroring #142's arrayEdit/onArrayAdd gate) — its mere
// presence is the gate, so no separate immutable/isSortable flag travels in the payload the way
// ColumnHeaderContext's `immutable` does. `arrayLength` only exists to derive canMoveUp/canMoveDown
// (package.json's `when`-clause gate for Move Up/Move Down, mirroring `immutable`'s role for
// columnHeader.removeOverride) — Remove has no boundary condition, so `index` alone still gates it.
//
// Issue #231 (review): keyed by `fieldName` — the caller's job is to pass the row's own wire
// identity (`context.rootField`), not its display label; the two only coincide for an ordinary
// top-level array; a VMAD/Condition array's own wire path is a separate string (#231's own "wire
// paths differ" friction). Returns the plain object, not a JSON string — a row can carry more
// than one of these at once (e.g. a VMAD array-of-scalars property is both an array parent/
// element *and* a VMAD property target), so building the final `data-vscode-context` string is
// combineVscodeContexts' job below, not each builder's own.
export function arrayElementContext(formKey: string, plugin: string, fieldName: string, index: number, arrayLength: number): ArrayElementContext {
  return {
    webviewSection: 'arrayElement', formKey, plugin, fieldName, index,
    // Issue #168: `canMoveUp` must also check hasElementAt (this plugin's own real length), or
    // the menu offers Move Up on a row this plugin doesn't have an element in at all — canMoveDown
    // doesn't need the same explicit check since index < arrayLength - 1 already implies it.
    canMoveUp: index > 0 && hasElementAt(arrayLength, index), canMoveDown: index < arrayLength - 1,
    preventDefaultContextMenuItems: true,
  };
}

// Issue #231 (review): keyed by `fieldName` here too, now matching arrayElementContext above —
// the caller passes the row's own wire identity (`context.rootField`/`diff.wirePath ?? diff.
// fieldName`), not its display label. This was the actual cause of "a VMAD array-of-scalars
// property's Add doesn't resolve via the right-click menu broadcast": the broadcast handler
// (RecordPanel's resolveCurrentArrayFor) looks the row up by wire identity, and a display label
// was never that for a VMAD property.
export function arrayParentContext(formKey: string, plugin: string, fieldName: string): ArrayParentContext {
  return { webviewSection: 'arrayParent', formKey, plugin, fieldName, preventDefaultContextMenuItems: true };
}

// Issue #231: same mechanism as arrayElementContext/arrayParentContext above, carried by VMAD's
// own row kinds instead — see VmadScriptsContext/VmadScriptContext/VmadPropertyContext's own doc
// comment (messages.ts) for why no extra identity travels beyond script/property name.
export function vmadScriptsContext(formKey: string, plugin: string): VmadScriptsContext {
  return { webviewSection: 'vmadScripts', formKey, plugin, preventDefaultContextMenuItems: true };
}

export function vmadScriptContext(formKey: string, plugin: string, scriptName: string, currentFlags: string | null): VmadScriptContext {
  return { webviewSection: 'vmadScript', formKey, plugin, scriptName, currentFlags, preventDefaultContextMenuItems: true };
}

export function vmadPropertyContext(formKey: string, plugin: string, scriptName: string, propName: string): VmadPropertyContext {
  return {
    webviewSection: 'vmadProperty', formKey, plugin, scriptName, propName, preventDefaultContextMenuItems: true,
  };
}

// Issue #231 (review): combines every context object sharing one row into the single
// `data-vscode-context` string that element actually carries — VS Code's own `webviewSection`
// key supports a space-separated multi-token value today via the `=~` regex `when`-clause
// operator (the same convention `contextValue`/`viewItem` already uses for TreeItems, e.g.
// `viewItem =~ /\bfoo\b/`), so `webviewSection` here becomes the union of every context's own
// token and every command's `package.json` `when` clause matches its own with `=~ /\btoken\b/`.
// This is what lets a VMAD array-of-scalars property be *both* an array parent/element (Add/
// Remove/Move Up/Move Down) *and* a VMAD property (Remove Property) on the very same cell — the
// two were mutually exclusive before this (an `arrayVscodeContext ?? structOpVscodeContext`
// either/or), which was the actual cause of "Remove Property doesn't reach a VMAD array property"
// being broader than just the structList case it was first noticed on. Every other key
// (formKey/plugin/preventDefaultContextMenuItems, and each context's own extra identity fields)
// merges in directly — they're always equal across contexts sharing one row, so last-write-wins
// is harmless.
// `object`, not `Record<string, unknown>`, so every context builder's own named-property
// interface (ArrayParentContext, VmadPropertyContext, …) is assignable here directly — none of
// them carry an index signature, which `Record<string, unknown>` would otherwise demand of them.
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

export type Column =
  | { kind: 'disk'; override: CompareOverride }
  | { kind: 'pending'; plugin: string };

export function buildColumns(overrides: CompareOverride[], immutableSet?: Set<string>): Column[] {
  const cols: Column[] = [];
  for (const o of overrides) {
    cols.push({ kind: 'disk', override: o });
    if (o.pendingFields && Object.keys(o.pendingFields).length > 0 && !immutableSet?.has(o.plugin)) {
      cols.push({ kind: 'pending', plugin: o.plugin });
    }
  }
  return cols;
}

// ── Array child helpers ───────────────────────────────────────────────────────

export function parseElementIndex(fieldName: string): number {
  return Number.parseInt(fieldName.slice(1, -1), 10);
}

export function pendingIfChanged(pending: unknown, disk: unknown): unknown {
  if (pending === undefined) return undefined;
  if (pending === disk) return undefined;
  if (JSON.stringify(pending) === JSON.stringify(disk)) return undefined;
  return pending;
}

// Issue #168 (review): the one definition of "does this plugin's own array actually have an
// element at this index" — a row's index comes from the union-aligned tree across every plugin's
// column (an ordinary array with differing per-plugin lengths, or VMAD/Condition's own positional
// alignment), not from this one plugin's own array, so it can be at or past *this specific*
// array's length even though the row itself exists (because a sibling plugin has more elements
// there). Previously reimplemented ad hoc at four call sites (moveArrayElement, removeArrayElement,
// arrayElementContext's canMoveUp, DiffRow's computeArrayOps) with slightly different shapes — two
// checked `index < 0`, two didn't — the exact kind of independent drift that caused VMAD's original
// bug relative to Condition's already-correct one. `length` rather than the array itself so
// arrayElementContext (which only ever has `arrayLength`, no array) can share it too.
export function hasElementAt(length: number, index: number): boolean {
  return index >= 0 && index < length;
}

// Issue #227: the three pure array-arity/order mutations behind Move Up/Move Down/Remove/Add —
// extracted out of #142's DiffRow-local ArrayElementControls/ArrayAddButton (deleted by this
// ticket) so the keyboard accelerator (DiskCell's onKeyDown, a pure in-webview call) and the
// right-click menu's broadcast handler (RecordPanel, arriving asynchronously from the extension
// host) restage the array identically without needing to share one runtime call path — they
// structurally can't, since one runs inside a row's render closure and the other inside a
// mount-effect message listener. Each returns a new array; callers restage the whole thing via
// onArrayEdit/handleEdit, unchanged from #142's single-field-edit behavior.
// Issue #168: `index` itself must be bounds-checked here, not just the swap target `j` (index
// === array.length, direction -1 → j = index - 1, which passes a j-only guard) — without it, the
// destructuring swap extends the array by one slot and duplicates a value (`next[index]` is
// undefined, written into a slot one past the end) instead of the "return the array unchanged"
// no-op every other boundary already gets.
export function moveArrayElement(array: unknown[], index: number, direction: -1 | 1): unknown[] {
  const j = index + direction;
  if (!hasElementAt(array.length, index) || !hasElementAt(array.length, j)) return array;
  const next = [...array];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

// Issue #168: bounds-checked the same way moveArrayElement is — `Array.prototype.filter` already
// leaves the *content* unchanged for an out-of-range index (no element carries that index to
// drop), but it still hands back a new array reference, which defeats a caller's
// reference-equality no-op check (the same convention moveArrayElement's boundary case relies on,
// and RecordPanel's handleArrayMove/handleArrayRemove use to skip staging a no-op edit).
export function removeArrayElement(array: unknown[], index: number): unknown[] {
  if (!hasElementAt(array.length, index)) return array;
  return array.filter((_, i) => i !== index);
}

export function appendArrayElement(array: unknown[], value: unknown): unknown[] {
  return [...array, value];
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

// Issue #231: extracts a row's own pending value out of the root's raw pending value, generalizing
// DiffRow's old top-level/array-element/struct-child/grandchild switch (each hand-coded one
// nesting level) to any depth. Every hop but the last is a plain, bounds-safe read (getAtPath);
// the last hop needs one of three different "is there really a pending value here" rules, which
// is why it isn't just `getAtPath(rawPending, path)`: a struct member is a plain lookup, a
// positional array element is bounds-checked (out of range → undefined, matching a shrunk pending
// array), and a sorted-array element is checked by *value* (its own key must still be an element
// of the pending array at all — the array's own order carries no identity for it, unlike a
// positional element). Callers wrap the result in pendingIfChanged themselves, same as the old
// switch's per-case call.
export function pendingValueAtPath(rawPending: unknown, path: readonly PathSegment[]): unknown {
  if (path.length === 0) return rawPending;
  const parent = getAtPath(rawPending, path.slice(0, -1));
  const last = path.at(-1)!;
  if (last.kind === 'member') return (parent as Record<string, unknown> | undefined)?.[last.name];
  if (last.kind === 'index') return Array.isArray(parent) ? (parent as unknown[])[last.index] : undefined;
  return Array.isArray(parent) && (parent as unknown[]).includes(last.key) ? last.key : undefined;
}

// Issue #142: the value a freshly-appended array element starts with, derived from the
// element's own FieldMetadata (RecordPanel's "＋" control on an unsorted array's parent row).
// Struct elements (e.g. Factions: { Faction: FormKey, Rank: int }) recurse field-by-field —
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
