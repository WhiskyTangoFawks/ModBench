import { isFieldType, type ColumnKey, type CompareOverride, type FieldDiff, type FieldMetadata, type FieldValue, type PathHop, type PathSegment } from './types';
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

/** The record as the panel names it: the EditorID and the FormKey, or the FormKey alone. */
export function recordLabel(overrides: readonly CompareOverride[], formKey: string): string {
  const editorId = (overrides.find(o => o.isWinner) ?? overrides.at(0))?.editorId;
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

// ── Array child helpers ───────────────────────────────────────────────────────

// A keyed array is stored in key order on every write, so no Move there could change the file.
export function isArrayElementHop(seg: PathSegment | undefined): boolean {
  return seg !== undefined && seg.kind !== 'member';
}

export function isMovableElementHop(seg: PathSegment | undefined): boolean {
  return seg?.kind === 'index';
}

// A keyed array included, where a new element starts with the empty key.
export function offersArrayAdd(meta: FieldMetadata | undefined): boolean {
  return meta?.type === 'array' && !!meta.elementType;
}

// A keyed array's child is addressed by the key text as the backend labelled it, every other
// array's by its position in each column that holds it.
export function elementSegment(
  arrayMeta: FieldMetadata, fieldName: string, indexes: Readonly<Record<string, number>>,
): PathSegment {
  return arrayMeta.keyMembers ? { kind: 'key', key: fieldName } : { kind: 'element', indexes };
}

/** Each column's own position for each row of an array without a key: a column holds an element
 *  on exactly the rows where its value is, since an element is spelled in full. */
export function elementIndexes(rows: readonly FieldDiff[]): Record<string, number>[] {
  const held = new Map<string, number>();
  return rows.map(row => {
    const indexes: Record<string, number> = {};
    for (const [column, value] of Object.entries(row.values)) {
      if (value == null) continue;
      indexes[column] = held.get(column) ?? 0;
      held.set(column, indexes[column] + 1);
    }
    return indexes;
  });
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

// `siblings` is the length of the array in this column's own document.
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, path: PathHop[], siblings: number,
): ArrayElementContext {
  const lastSeg = path.at(-1);
  const movable = isMovableElementHop(lastSeg);
  const index = lastSeg?.kind === 'index' ? lastSeg.index : -1;
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, path,
    canMoveUp: movable && index > 0,
    canMoveDown: movable && index < siblings - 1,
    preventDefaultContextMenuItems: true,
  };
}

// `path` addresses the array itself — a top-level array's is the one member hop.
export function arrayParentContext(
  formKey: string, plugin: string, origin: string, path: PathHop[],
): ArrayParentContext {
  return { webviewSection: 'arrayParent', formKey, plugin, origin, path, preventDefaultContextMenuItems: true };
}

export function headerCellContext(
  formKey: string, plugin: string, origin: string, compilable: boolean,
): ColumnHeaderContext {
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

export function getAtPath(root: unknown, path: readonly PathHop[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (seg.kind === 'member') cur = (cur as Record<string, unknown> | undefined)?.[seg.name];
    else if (seg.kind === 'index') cur = Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined;
    else cur = undefined;
  }
  return cur;
}

/** The hops `column`'s envelope carries for a row under `rootField`; an element the column does
 *  not hold has no position, which mEdit refuses. */
export function wirePath(rootField: string, path: readonly PathSegment[], column: ColumnKey): PathHop[] {
  return [
    { kind: 'member', name: rootField },
    ...path.map((seg): PathHop => seg.kind === 'element' ? { kind: 'index', index: seg.indexes[column] ?? -1 } : seg),
  ];
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
  meta: FieldMetadata | undefined, path: readonly PathHop[], root?: unknown,
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

