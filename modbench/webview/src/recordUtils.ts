import { isFieldType, type ColumnKey, type CompareOverride, type FieldMetadata, type FieldValue, type PathHop, type PathSegment } from './types';
import { columnKey } from './columnKey';

export function toStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  // JSON.stringify returns undefined for these two, whatever its declared type says.
  if (typeof v === 'function' || typeof v === 'symbol') return '';
  return JSON.stringify(v);
}

// ADR-0012: `key` is this column's compound identity, minted once here rather than re-derived, so
// two same-filename columns stop colliding. ADR-0007/ADR-0018: one column per override — the
// record's full in-game resolution stack.
export type Column = { key: ColumnKey; override: CompareOverride };

// xEdit's own layout: load order ascending, master leftmost, winner rightmost — the wire order
// itself (GetOverrideStack's ORDER BY load_order_idx), trusted rather than re-sorted here.
export function buildColumns(overrides: CompareOverride[]): Column[] {
  return overrides.map(o => ({ key: columnKey(o.plugin, o.origin), override: o }));
}

// `immutableSet` says only that a column is immutable, which is ambiguous: a vanilla master is
// immutable and named by the load order, while a plugin the load order doesn't name (ADR-0012) is
// immutable *because* it isn't.
export type ColumnStatus =
  'parseFailure' | 'vanillaMaster' | 'notInLoadOrder' | 'untracked' | 'tracked';

/** Ordered by what the user can do about it: a parse failure and an immutable column come first,
 *  since nothing the user does about tracking lifts either — naming the wrong way out is worse
 *  than naming none. */
export function columnStatus(
  isImmutable: boolean, inLoadOrder: boolean, isTracked = true, parseDiagnosis?: string | null,
): ColumnStatus {
  if (parseDiagnosis != null) return 'parseFailure';
  if (isImmutable) return inLoadOrder ? 'vanillaMaster' : 'notInLoadOrder';
  return isTracked ? 'tracked' : 'untracked';
}

// ADR-0012: origin appears inline in the header only when two plugins share a filename — computed
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

// An array sorted by its own element value (xEdit's wbArrayS): its elements are pure links, which
// the element type alone says.
function isPureLinkArray(meta: FieldMetadata): boolean {
  return meta.elementType?.type === 'formKey';
}

// Add applies to any array whose elements are not themselves the value — a keyed array included,
// where a new element starts with the empty key.
export function offersArrayAdd(meta: FieldMetadata | undefined): boolean {
  return meta?.type === 'array' && !!meta.elementType && !isPureLinkArray(meta);
}

// A keyed array's child is addressed by the key text as the backend labelled it, a pure-FormLink
// array's by the element value, every other array's by the child's place among its siblings.
export function elementSegment(arrayMeta: FieldMetadata, fieldName: string, ordinal: number): PathSegment {
  if (arrayMeta.keyMembers) return { kind: 'key', key: fieldName };
  if (isPureLinkArray(arrayMeta)) return { kind: 'value', value: fieldName };
  return { kind: 'index', index: ordinal };
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

// Only the near end is bounded: the row's index spans every column, so this column's own length
// is not known here, and a move off the far end is the backend's to refuse by name.
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, path: PathHop[],
): ArrayElementContext {
  const lastSeg = path.at(-1);
  const movable = isMovableElementHop(lastSeg);
  const index = lastSeg?.kind === 'index' ? lastSeg.index : -1;
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, path,
    canMoveUp: movable && index > 0,
    canMoveDown: movable,
    preventDefaultContextMenuItems: true,
  };
}

// `path` addresses the array itself — a top-level array's is the one member hop.
export function arrayParentContext(
  formKey: string, plugin: string, origin: string, path: PathHop[],
): ArrayParentContext {
  return { webviewSection: 'arrayParent', formKey, plugin, origin, path, preventDefaultContextMenuItems: true };
}

export function headerCellContext(formKey: string, plugin: string, origin: string, compilable: boolean): ColumnHeaderContext {
  return { webviewSection: 'recordHeader', formKey, plugin, origin, compilable, preventDefaultContextMenuItems: true };
}

// ADR-0018: a `string` cell's right-click entry is the extended editor's only trigger, since no
// left-click gesture may reach it. Offered on immutable cells too — `readOnly` is what the
// command's `when` clause acts on.
export function stringValueContext(
  formKey: string, plugin: string, origin: string, recordLabel: string, fieldName: string, value: string,
  readOnly: boolean, path: PathHop[],
): StringValueContext {
  return {
    webviewSection: 'stringValue', formKey, plugin, origin, recordLabel, fieldName, value, readOnly, path,
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
export type { PathHop, PathSegment };

/** This column's own entry for the record member a row's subtree is rooted at: the document a wire
 *  path resolves against, and where a check error on that member lives. */
export function rootFieldOf(override: CompareOverride | undefined, rootField: string): FieldValue | undefined {
  return override?.fields.find(f => f.metadata.name === rootField);
}

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

// Absent means default (ADR-0005): the metadata names the default where it is not the type's
// zero. A link, a struct and the text-encoded leaves have no default here, so they keep the
// grid's "no value" rendering.
export function defaultOf(meta: FieldMetadata): unknown {
  if (meta.default != null) return meta.default;
  if (!isFieldType(meta.type)) return undefined;
  switch (meta.type) {
    case 'int': case 'float': return 0;
    case 'bool': return false;
    case 'string': case 'translatedString': return '';
    case 'flags': case 'array': return [];
    case 'enum': case 'formKey': case 'struct': case 'hex': case 'color': case 'vector': return undefined;
  }
}

/** Whether a column holds this node. Absent means default (ADR-0005), and a non-nullable
 *  struct's default is that struct; a nullable one has an "unset" for its absence to mean. */
export function columnHasNode(meta: FieldMetadata, value: unknown): boolean {
  return value != null || !(meta.type === 'struct' && meta.allowsNull);
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
  return typeof leaf === 'string' ? meta.variants[leaf] ?? meta : meta;
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

