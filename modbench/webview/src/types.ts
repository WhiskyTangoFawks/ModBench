import type { components } from '../../src/medit/generated/api';

type Schemas = components['schemas'];

// The record editor's wire DTOs. Every type here is the generated schema type — named, and in a
// few cases *narrowed*. The narrowings are the only hand-written shape left, and each one passes
// the same test: would this still need to exist if the generator were perfect? Narrowing a wire
// `string` to the closed set this side switches on exhaustively is a genuine frontend refinement
// and stays; re-declaring a field the schema already describes is a second, staler copy and does
// not (#627).

export type FormKeyResolutionState = Schemas['FormKeyResolutionState'];
export type FormKeyResolution = Schemas['FormKeyResolution'];
export type ConflictAll = Schemas['ConflictAll'];
export type ConflictThis = Schemas['ConflictThis'];
export type EnumMember = Schemas['EnumMember'];
/** The widget a leaf renders with — the backend's own `type` string, narrowed to the closed set
 *  DiffRow switches on exhaustively. */
export type FieldType =
  | 'string' | 'int' | 'float' | 'bool' | 'enum' | 'formKey' | 'struct' | 'array' | 'hex';

/** `readOnly` is a per-row stamp the panel applies (the header's own masters field), unconditional
 *  regardless of the column's own mutability; every other field's editability still comes purely
 *  from the column (immutableSet), matching the "per column, never a mode" rule. */
export type FieldMetadata =
  // `isDiscriminator` says which member of a struct names the concrete class its object is —
  // `concrete_type` for a Loqui union, OMOD's `value_type` for its own. Read by the presentation
  // table (presentation.ts) to find a collapsed element's leaf, which is the one thing on this
  // side that has to know a leaf apart from its siblings; nothing else here reads it, and nothing
  // writes it.
  Omit<Schemas['FieldMetadata'],
    'type' | 'elementType' | 'fields' | 'isSortable' | 'allowsNull' | 'isDiscriminator'> & {
    type: FieldType;
    elementType?: FieldMetadata | null;   // present when type === 'array'
    fields?: FieldMetadata[] | null;      // present when type === 'struct'
    readOnly?: boolean;
    // Required non-nullable booleans on the wire, optional here so a test fixture can leave a
    // question that does not apply to its row unanswered rather than fabricating `false` for it.
    isSortable?: boolean;   // on elementType: true for pure FormLink arrays
    allowsNull?: boolean;   // for 'formKey': true when the Mutagen type is IFormLinkNullable<T>
    isDiscriminator?: boolean;  // this member names its object's concrete leaf
  };

export type FieldValue = Omit<Schemas['FieldValue'], 'metadata'> & { metadata: FieldMetadata };

// ADR-0036: a compare-grid column is identified by (plugin, origin), not plugin alone —
// two columns can share a filename (shadowed copies). `ColumnKey` is a branded
// string, minted only by `columnKey()` below, so every place that carries column identity
// (focusedCell, collapsedColumns, immutableSet, overrideMap's key, the drag source,
// addPropertyTarget — see DiffRow.tsx/RecordPanel.tsx) can be typed as `ColumnKey` rather than
// `string`: comparing it against a bare `plugin` string becomes a compile error instead of a
// silent same-filename collision. `Record<ColumnKey, T>`/`{ [k: string]: T }` still erase the
// brand (a mapped type over a non-literal string collapses to an index signature) — the
// per-column dictionaries on the wire (FieldDiff.values, FieldDiff.cellStates, etc.) are not
// type-protected by this and rely on the value actually being `ColumnKey.Of`'s output instead.
export type ColumnKey = string & { readonly __col: unique symbol };

// Mirrors the backend's ColumnKey.Of (MEditService.Core/Queries/ColumnKey.cs) exactly, so a key
// minted here always agrees with one minted server-side for the same (plugin, origin) pair:
// `|` delimiter (illegal in a Windows filename and an MO2 mod-folder name), and the
// Data-directory origin is elided (a plugin resolved from the game's single Data/ is already
// uniquely identified by its filename) so a plain-filename fixture never needs rekeying.
//
// Case: only the *Data-origin check* is case-folded here (`origin.toLowerCase() === 'data'`) —
// plugin names compare OrdinalIgnoreCase in places and Windows filenames are case-insensitive, so
// "Data"/"data"/"DATA" must all elide the same way regardless of which casing a given response
// happens to use. The *returned* key otherwise preserves the caller's own casing verbatim (does
// not lowercase plugin/origin into the output) — deliberately: pervasively folding the whole key
// would mean the immutableSet/RecordPanelClient mismatch this guards against (two independently
// -fetched responses disagreeing only in case) trades for making every ColumnKey unreadable and
// disagreeing with the exact plugin string every existing caller already threads through
// (onFocusCell/onEdit/onCellDragStart/onCellDrop's payloads, action broadcasts) for no case-
// mismatch anyone has actually observed. The backend does not fold at all (see ColumnKey.Of's own
// doc comment) — this key is only ever used as an opaque local lookup key against JSON the backend
// produced, never sent back to it, so the two sides folding differently has no wire consequence.
//
// ADR-0036: `origin` is required — every wire type that feeds this (RecordDetail.origin,
// PluginResponse.origin) is a required, non-nullable `string` too, so a caller cannot skip
// specifying it and silently collapse onto the elided Data origin.
//
// `origin` still accepts a literal `null` value, even though every one of those hand
// types claims it never will be. Investigated: it provably can't be, today — the
// backend fields behind all three (`RecordDetail.Origin`/`CompareOverride.Origin`/
// `PluginResponse.Origin`, MEditService.Core/Queries/Models.cs and
// Load order/PluginMetadata.cs) are non-nullable C# `string`s, always populated from
// `PluginOrigin.DataDirectory` or an already-normalized value (`LoadOrderEndpoints.cs`'s
// `string.IsNullOrEmpty(p.Origin) ? PluginOrigin.DataDirectory : p.Origin` is the one place a
// nullable origin — `ExplicitPlugin.Origin`, a *request* shape, never returned to a client —
// exists at all, and it's resolved before touching any read-side DTO), and every one of those
// origin columns is `NOT NULL` in DuckDB, read via an unguarded `reader.GetString(...)` that would
// throw server-side rather than let a null through. The generated wire schema still types every
// one of these fields `string | null` regardless (`api.ts`'s `origin?: string | null` — an
// artifact of the OpenAPI generator not reading C# nullable-reference-type annotations, applied
// uniformly to every string field on the wire, not something specific to origin), and
// RecordPanelClient's `load()` casts that raw response straight into these hand types with an
// unchecked `as` (its own comment: the generated per-operation types are "looser than this
// webview's own hand-declared DTOs" by design — every call site already trusts a non-nullable
// backend field stays non-null past that cast). `columnKey()` is the one place in the whole client
// that actually dereferences `origin` (`.toLowerCase()`) rather than just storing/displaying it, so
// it's the one call site where that trust being wrong would crash instead of silently doing
// nothing — tolerating a literal `null` here the same as a missing field is cheap insurance against
// the wire's own declared (if not actually reachable) shape, not a sign null is expected.
export function columnKey(plugin: string, origin: string | null): ColumnKey {
  const resolvedOrigin = origin ?? 'Data';
  const key = resolvedOrigin.toLowerCase() === 'data' ? plugin : `${plugin}|${resolvedOrigin}`;
  return key as ColumnKey;
}

export type RecordDetail = Omit<Schemas['RecordDetail'], 'fields'> & { fields: FieldValue[] };

export type CompareOverride = Omit<Schemas['CompareOverride'], 'fields'> & { fields: FieldValue[] };

// The chain from a row's own restage root — the reflected field it stages under — down to a
// given row's
// own value: a struct hop addressed by member name, an unsorted-array hop by position, a sorted
// (pure FormLink) array hop by the element's own value (there is nothing to address *beneath* a
// sortKey hop — a sorted array's elements are themselves the value, never a struct/array).
// Lives in src/medit/messages.ts — the shared module the extension host imports
// directly (StringValueContext/FIELD_OPEN_EXTENDED_EDITOR carry this too), so it can cross to
// the extension host without importing a webview type the wrong way. Re-exported here since every
// caller in this module (and recordUtils.ts's own re-export) imports it from
// './types'.
export type { PathSegment } from './messages';

/** `conflictAll` is required on the wire but optional here, so a test fixture that says nothing
 *  about a row's conflict state degrades to "no background" in DiffRow's getRowBg rather than
 *  having to state one. */
export type FieldDiff = Omit<Schemas['FieldDiff'], 'children' | 'conflictAll'> & {
  conflictAll?: ConflictAll;
  children?: FieldDiff[] | null;
};

export type CompareResult = Omit<Schemas['CompareResult'], 'overrides' | 'diffs'> & {
  overrides: CompareOverride[];
  diffs: FieldDiff[];
};
