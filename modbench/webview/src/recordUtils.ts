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

/** The record as the panel names it: the EditorID and the FormKey, or the FormKey alone. */
export function recordLabel(overrides: readonly CompareOverride[], formKey: string): string {
  const editorId = (overrides.find(o => o.isWinner) ?? overrides.at(0))?.editorId;
  return editorId ? `${editorId} [${formKey}]` : formKey;
}

// ── Array child helpers ───────────────────────────────────────────────────────

export function isArrayElementHop(seg: PathSegment | undefined): boolean {
  return seg !== undefined && seg.kind !== 'member';
}

// A keyed array included, where a new element starts with the empty key.
export function offersArrayAdd(meta: FieldMetadata | undefined): boolean {
  return meta?.type === 'array' && !!meta.elementType;
}

// ── Native right-click menu contexts ──────────────────────────────────────────
//
// VS Code gates these on a `data-vscode-context` attribute carrying JSON it parses itself, never a
// rendered menu. One row can carry more than one context, so each builder returns a plain object.
export type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext, EditableCellContext, ReferenceContext,
  StringValueContext,
} from './messages';
import type {
  ArrayElementContext, ArrayParentContext, ColumnHeaderContext, EditableCellContext, ReferenceContext,
  StringValueContext,
} from './messages';

// `siblings` is the length of the array in this column's own document. xedit.md, divergence 14: a
// keyed array takes no move.
export function arrayElementContext(
  formKey: string, plugin: string, origin: string, path: PathHop[], siblings: number, keyed: boolean,
): ArrayElementContext {
  const lastSeg = path.at(-1);
  const index = lastSeg?.kind === 'index' && !keyed ? lastSeg.index : -1;
  return {
    webviewSection: 'arrayElement', formKey, plugin, origin, path,
    canMoveUp: index > 0,
    canMoveDown: index >= 0 && index < siblings - 1,
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
  formKey: string, plugin: string, origin: string, editable: boolean,
): ColumnHeaderContext {
  return { webviewSection: 'recordHeader', formKey, plugin, origin, editable, preventDefaultContextMenuItems: true };
}

// Every cell suppresses VS Code's own Cut, Copy and Paste, which act on the text on the screen, and
// offers copy value the text ADR-0018 says it copies.
export function cellContext(copyText: string | undefined): { webviewSection: 'cell'; copyText?: string; preventDefaultContextMenuItems: true } {
  return { webviewSection: 'cell', ...(copyText === undefined ? {} : { copyText }), preventDefaultContextMenuItems: true };
}

export function editableCellContext(
  formKey: string, plugin: string, origin: string, path: PathHop[], holdsValue: boolean,
): EditableCellContext {
  return { webviewSection: 'editableCell', formKey, plugin, origin, path, holdsValue };
}

export function referenceContext(referenceTarget: string): ReferenceContext {
  return { webviewSection: 'reference', referenceTarget };
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
    else cur = Array.isArray(cur) ? (cur as unknown[])[seg.index] : undefined;
  }
  return cur;
}

/** The hops `column`'s envelope carries for a row under `rootField`, or none where the column
 *  holds no element on the way. */
export function wirePath(rootField: string, path: readonly PathSegment[], column: ColumnKey): PathHop[] | undefined {
  const hops: PathHop[] = [{ kind: 'member', name: rootField }];
  for (const seg of path) {
    if (seg.kind !== 'element') {
      hops.push(seg);
      continue;
    }
    const index = seg.indexes?.[column];
    if (index == null) return undefined;
    hops.push({ kind: 'index', index });
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

