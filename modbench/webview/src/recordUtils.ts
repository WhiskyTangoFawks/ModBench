import type { ColumnKey, CompareOverride, FieldMetadata, PathSegment } from './types';
import { columnKey } from './types';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  // JSON.stringify returns undefined for these two, whatever its declared type says.
  if (typeof v === 'function' || typeof v === 'symbol') return '';
  return JSON.stringify(v);
}

// ADR-0036: `key` is this column's compound identity, minted once here rather than re-derived, so
// two same-filename columns stop colliding. ADR-0041/ADR-0019: one column per override — the
// record's full in-game resolution stack.
export type Column = { key: ColumnKey; override: CompareOverride };

// xEdit's own layout: load order ascending, master leftmost, winner rightmost — the wire order
// itself (GetOverrideStack's ORDER BY load_order_idx), trusted rather than re-sorted here.
export function buildColumns(overrides: CompareOverride[]): Column[] {
  return overrides.map(o => ({ key: columnKey(o.plugin, o.origin), override: o }));
}

// `immutableSet` says only that a column is immutable, which is ambiguous: a vanilla master is
// immutable and named by the load order, while a copy the load order doesn't name (ADR-0036) is
// immutable *because* it isn't.
export type ColumnStatus = 'vanillaMaster' | 'notInLoadOrder' | 'untracked' | 'tracked';

/** Ordered by what the user can do about it: the two reasons they cannot fix here come first, so
 *  a vanilla master is never told to run Track — naming the wrong way out is worse than naming
 *  none. */
export function columnStatus(
  isImmutable: boolean, inLoadOrder: boolean, isTracked = true,
): ColumnStatus {
  if (isImmutable) return inLoadOrder ? 'vanillaMaster' : 'notInLoadOrder';
  return isTracked ? 'tracked' : 'untracked';
}

// ADR-0036: origin appears inline in the header only when two copies share a filename — computed
// from the overrides this compare response carries, never the load order's plugin list. Two rows
// can never share both plugin and origin.
export function collidingFilenames(overrides: CompareOverride[]): Set<string> {
  const counts = new Map<string, number>();
  for (const o of overrides) counts.set(o.plugin, (counts.get(o.plugin) ?? 0) + 1);
  return new Set([...counts].filter(([, n]) => n > 1).map(([plugin]) => plugin));
}

// ── Array child helpers ───────────────────────────────────────────────────────

// An unsorted array's child is labelled "[N]" by the backend; a keyed array's child is labelled by
// its key instead.
export function parseElementIndex(fieldName: string): number {
  return Number.parseInt(fieldName.slice(1, -1), 10);
}

// Read the way the backend reads it (Queries/ElementKey.cs) — a dotted member name walks into a
// sub-struct. The backend's own text labels the row a key comes from, so the two renderings are
// one contract.
export function elementKeyText(element: unknown, members: readonly string[]): string {
  return members.map(member => memberKeyText(element, member)).join(' / ');
}

function memberKeyText(element: unknown, member: string): string {
  let cur = element;
  for (const hop of member.split('.')) {
    if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) return '';
    cur = (cur as Record<string, unknown>)[hop];
  }
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  // A flags member is an array of names (a scene phase fragment keys on its Flags).
  if (Array.isArray(cur)) return cur.map(String).join(', ');
  return '';
}

// Per column by construction: the same key is a different position in every plugin that carries
// it, and the caller always passes the array it is about to read or write.
export function keyedElementIndex(list: readonly unknown[], seg: KeySegment): number {
  return list.findIndex(element => elementKeyText(element, seg.members) === seg.key);
}

type KeySegment = Extract<PathSegment, { kind: 'key' }>;

// A keyed array is stored in key order on every write, so no Move there could change the file; a
// pure-FormLink array's order is its sort key, so it offers nothing at all.
export function isArrayElementHop(seg: PathSegment | undefined): boolean {
  return seg?.kind === 'index' || seg?.kind === 'key';
}

export function isMovableElementHop(seg: PathSegment | undefined): boolean {
  return seg?.kind === 'index';
}

// Add applies to any array whose elements are not themselves the value — a keyed array included,
// where a new element starts with the empty key.
export function offersArrayAdd(meta: FieldMetadata | undefined): boolean {
  return meta?.type === 'array' && !!meta.elementType && !meta.elementType.isSortable;
}

// How the backend labelled an array's child is what says how to address it: a keyed array's
// children are named by key, a pure-FormLink array's by the element value, every other array's
// by "[N]".
export function elementSegment(arrayMeta: FieldMetadata, fieldName: string): PathSegment {
  if (arrayMeta.keyMembers) return { kind: 'key', key: fieldName, members: arrayMeta.keyMembers };
  if (arrayMeta.elementType?.isSortable) return { kind: 'sortKey', key: fieldName };
  return { kind: 'index', index: parseElementIndex(fieldName) };
}

// A row's index comes from the union-aligned tree across every plugin's column, not from this one
// plugin's array, so it can be at or past *this* array's length even though the row exists.
export function hasElementAt(length: number, index: number): boolean {
  return index >= 0 && index < length;
}

// ── Native right-click menu contexts ──────────────────────────────────────────
//
// VS Code gates these on a `data-vscode-context` attribute carrying JSON it parses itself, never a
// rendered menu. One row can carry more than one context, so each builder returns a plain object.
export type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext,
  StringValueContext,
} from './messages';
import type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext,
  StringValueContext,
} from './messages';

// Its mere presence is the gate, so no immutable/isSortable flag travels in the payload.
// `arrayLength` only exists to derive canMoveUp/canMoveDown. `path` is the element's full chain of
// hops, which a scalar index could never carry.
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, rootField: string, path: PathSegment[], arrayLength: number,
): ArrayElementContext {
  const lastSeg = path.at(-1);
  const index = lastSeg?.kind === 'index' ? lastSeg.index : -1;
  const movable = isMovableElementHop(lastSeg);
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, rootField, path,
    // `canMoveUp` must also check hasElementAt (this plugin's length), or the menu offers Move Up
    // on a row this plugin doesn't have an element in — canMoveDown needs no such check since
    // index < arrayLength - 1 already implies it.
    canMoveUp: movable && index > 0 && hasElementAt(arrayLength, index),
    canMoveDown: movable && index < arrayLength - 1,
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

export function headerCellContext(formKey: string, plugin: string, origin: string): ColumnHeaderContext {
  return { webviewSection: 'recordHeader', formKey, plugin, origin, preventDefaultContextMenuItems: true };
}

// ADR-0039: a `string` cell's right-click entry is the extended editor's only trigger, since no
// left-click gesture may reach it. Offered on immutable cells too — `readOnly` is what the
// command's `when` clause acts on.
export function stringValueContext(
  formKey: string, plugin: string, origin: string, fieldName: string, value: string, readOnly: boolean,
  path: PathSegment[], rootField: string,
): StringValueContext {
  return {
    webviewSection: 'stringValue', formKey, plugin, origin, fieldName, value, readOnly, path, rootField,
    preventDefaultContextMenuItems: true,
  };
}

// `webviewSection` supports a space-separated value via VS Code's `=~` regex `when`-clause
// operator, so this is the union of every context's token. Other keys are equal across contexts
// sharing one row, so last-write-wins is harmless.
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
// A complex field is written as one atomic unit (CONTEXT.md), so an edit anywhere in a struct or
// array writes the whole thing.
export type { PathSegment };

export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (seg.kind === 'member') cur = (cur as Record<string, unknown> | undefined)?.[seg.name];
    else if (seg.kind === 'index') cur = Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined;
    else if (seg.kind === 'key') cur = Array.isArray(cur) ? cur[keyedElementIndex(cur, seg)] : undefined;
    // sortKey: the element is its own value, so the key is what is there — where the array holds it.
    else cur = Array.isArray(cur) && cur.includes(seg.key) ? seg.key : undefined;
  }
  return cur;
}

// ADR-0041: the whole subtree commits as one atomic source write. Never mutates its input: each
// hop copies its own level before recursing, so a caller can compare the result against the
// original root by reference.
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
  if (seg.kind === 'key') {
    // A column that carries no element under this key is left exactly as it is — there is no
    // element there to write, and inventing one at a position would be the mistake the key hop
    // exists to prevent.
    const arr = Array.isArray(root) ? [...(root as unknown[])] : [];
    const at = keyedElementIndex(arr, seg);
    if (at >= 0) arr[at] = setAtPath(arr[at], rest, value);
    return arr;
  }
  // sortKey: always the final segment — replace the element whose current value matches the
  // segment's own key.
  const arr = Array.isArray(root) ? [...(root as unknown[])] : [];
  return arr.map(e => (e === seg.key ? value : e));
}

// The document's own discriminator member, the first key of every union element the codec writes.
export const DISCRIMINATOR = 'MutagenObjectType';

/** The shape a member has under the object holding it: its own, or the variant the object's
 *  discriminator names when the member's type varies by leaf. */
export function variantFor(meta: FieldMetadata, owner: unknown): FieldMetadata {
  if (!meta.variants || owner == null || typeof owner !== 'object') return meta;
  const leaf = (owner as Record<string, unknown>)[DISCRIMINATOR];
  return (typeof leaf === 'string' && meta.variants[leaf]) || meta;
}

// Reading `fieldMetaMap[rootField].elementType` finds the right element type only when the array
// itself is the subtree root; for a nested array it names the wrong node's. `?? undefined`
// collapses the wire's `T | null` at this one boundary. With `root`, the value at each hop picks a
// union member's variant.
export function metaAtPath(
  meta: FieldMetadata | undefined, path: readonly PathSegment[], root?: unknown,
): FieldMetadata | undefined {
  let cur: FieldMetadata | null | undefined = meta;
  let value: unknown = root;
  for (const seg of path) {
    if (!cur) return undefined;
    const owner = value;
    value = getAtPath(value, [seg]);
    cur = seg.kind === 'member' ? cur.fields?.find(f => f.name === seg.name) : cur.elementType;
    if (cur && seg.kind === 'member' && root !== undefined) cur = variantFor(cur, owner);
  }
  return cur ?? undefined;
}

