import type { ColumnKey, CompareOverride, FieldMetadata, PathHop, PathSegment } from './types';
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

// A keyed array's child is addressed by the key text as the backend labelled it, a pure-FormLink
// array's by the element value, every other array's by the child's place among its siblings.
export function elementSegment(arrayMeta: FieldMetadata, fieldName: string, ordinal: number): PathSegment {
  if (arrayMeta.keyMembers) return { kind: 'key', key: fieldName };
  if (arrayMeta.elementType?.isSortable) return { kind: 'value', value: fieldName };
  return { kind: 'index', index: ordinal };
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

// ── Reading the document along a row's path ──────────────────────────────────
export type { PathSegment };

export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (seg.kind === 'member') cur = (cur as Record<string, unknown> | undefined)?.[seg.name];
    else if (seg.kind === 'index') cur = Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined;
    else if (seg.kind === 'key') cur = undefined;
    // value: the element is its own value, so the key is what is there — where the array holds it.
    else cur = Array.isArray(cur) && cur.includes(seg.value) ? seg.value : undefined;
  }
  return cur;
}

/** The hops an envelope carries for a row under `rootField`: the row's own, with an element of a
 *  sorted array turned into its position in `document`, this column's own value of the root. */
export function wirePath(rootField: string, path: readonly PathSegment[], document: unknown): PathHop[] {
  const hops: PathHop[] = [{ kind: 'member', name: rootField }];
  let node = document;
  for (const seg of path) {
    hops.push(seg.kind === 'value'
      ? { kind: 'index', index: Array.isArray(node) ? node.indexOf(seg.value) : -1 }
      : seg);
    node = getAtPath(node, [seg]);
  }
  return hops;
}

// Absent means default (ADR-0032): the metadata names the default where it is not the type's
// zero. A link, a struct and the text-encoded leaves have no default here, so they keep the
// grid's "no value" rendering.
export function defaultOf(meta: FieldMetadata): unknown {
  if (meta.default != null) return meta.default;
  switch (meta.type) {
    case 'int': case 'float': return 0;
    case 'bool': return false;
    case 'string': case 'translatedString': return '';
    case 'flags': case 'array': return [];
    default: return undefined;
  }
}

// A member whose shape varies by leaf exists only under the leaves its variants name; every other
// member is every leaf's.
export function declaresMember(meta: FieldMetadata, owner: unknown, ownerMeta: FieldMetadata | undefined): boolean {
  const discriminator = discriminatorOf(ownerMeta);
  if (!meta.variants || discriminator == null || owner == null || typeof owner !== 'object') return true;
  const leaf = (owner as Record<string, unknown>)[discriminator];
  return typeof leaf !== 'string' || leaf in meta.variants;
}

// The member of a struct that names the concrete class its object is, as the metadata marks it.
export const discriminatorOf = (meta: FieldMetadata | undefined): string | undefined =>
  meta?.fields?.find(f => f.isDiscriminator)?.name;

/** The shape a member has under the object holding it: its own, or the variant the object's
 *  discriminator names when the member's type varies by leaf. */
export function variantFor(meta: FieldMetadata, owner: unknown, ownerMeta: FieldMetadata | undefined): FieldMetadata {
  const discriminator = discriminatorOf(ownerMeta);
  if (!meta.variants || discriminator == null || owner == null || typeof owner !== 'object') return meta;
  const leaf = (owner as Record<string, unknown>)[discriminator];
  return typeof leaf === 'string' && leaf in meta.variants ? meta.variants[leaf] : meta;
}

// `fieldMetaMap[rootField].elementType` is the right element type only when the array is the
// subtree root, never a nested array's. `?? undefined` collapses the wire's `T | null` here; `root`
// picks a union member's variant at each hop.
export function metaAtPath(
  meta: FieldMetadata | undefined, path: readonly PathSegment[], root?: unknown,
): FieldMetadata | undefined {
  let cur: FieldMetadata | null | undefined = meta;
  let value: unknown = root;
  for (const seg of path) {
    if (!cur) return undefined;
    const owner = value;
    const ownerMeta = cur;
    value = getAtPath(value, [seg]);
    cur = seg.kind === 'member' ? cur.fields?.find(f => f.name === seg.name) : cur.elementType;
    if (cur && seg.kind === 'member' && root !== undefined) cur = variantFor(cur, owner, ownerMeta);
  }
  return cur ?? undefined;
}

