export interface FieldMetadata {
  name: string;
  // Issue #231: 'vmadObject' | 'conditionFunction' | 'conditionRunOn' | 'conditionComparison' |
  // 'conditionParam' are synthesized only by the VMAD/Condition tree adapters
  // (vmadTreeAdapter.ts/conditionTreeAdapter.ts) — the backend never emits them (no schema/API
  // change). Each names a leaf whose editor is a genuine exception to the plain type→widget
  // mapping, the same way 'formKey' already is: a VMAD object property is a (FormKey, alias) pair
  // (#229's VmadObjectEditor); a condition's Function field opens a QuickPick over the function
  // catalogue, never a text/dropdown editor; Run On, Comparison and a parameter are each composite
  // (target+conditional reference; float vs GLOB FormKey depending on the condition's own
  // UseGlobal; FormKey/text/number depending on the parameter's own category) and vary their own
  // widget from their own value's shape, exactly as VmadObjectEditor already does — not from a
  // second per-plugin metadata branch DiffRow would otherwise need.
  type: 'string' | 'int' | 'float' | 'bool' | 'enum' | 'formKey' | 'struct' | 'array'
    | 'vmadObject' | 'conditionFunction' | 'conditionRunOn' | 'conditionComparison' | 'conditionParam';
  isArray: boolean;
  validFormKeyTypes: string[];
  enumValues: string[];
  elementType?: FieldMetadata;   // present when type === 'array'
  fields?: FieldMetadata[];       // present when type === 'struct'
  isSortable?: boolean;           // on elementType: true for pure FormLink arrays
  isBitmask?: boolean;            // true when the C# enum has [Flags]
  enumBitValues?: string[];       // present iff isBitmask; decimal string bit values aligned with enumValues
  // Issue #231: unconditionally read-only regardless of the column's own mutability — the
  // Condition section's AND/OR gate (no renderEdit at all, previously enforced by the field simply
  // having no editor built for it) is the one row that needs this; every other field's editability
  // still comes purely from the column (immutableSet), matching #111's "per column, never a mode"
  // rule for everything else.
  readOnly?: boolean;
  // Issue #231: overrides recordUtils.ts's generic defaultElementValue for a fresh array element,
  // for a synthesized elementType whose real wire shape isn't the generic per-field-type default
  // recordUtils.ts's own struct case would build. A condition list's own elementType is the one
  // caller: a new condition's wire shape is `ParsedCondition` (`{function, operator, or,
  // runOnTarget, ...}`), not an object keyed by this ticket's display field names ("Function",
  // "Run On", …) with a generic per-type scalar default in each — the two don't match. Absent for
  // every ordinary/VMAD elementType, which the generic per-type defaulting already gets right.
  defaultValue?: unknown;
}

export interface FieldValue {
  metadata: FieldMetadata;
  value: unknown;
  checkError?: string | null;
}

// ADR-0031: the tri-state resolution signal for a FormKey value, computed server-side against the
// global FormKey→(record type, EditorID) lookup. Unresolved means the FormKey isn't in the index
// (dangling); ResolvedWrongType/ResolvedValidType both mean the reference is followable (matches
// xEdit) — only Unresolved withholds the link affordance and the EditorID label.
export type FormKeyResolutionState = 'Unresolved' | 'ResolvedWrongType' | 'ResolvedValidType';

export interface FormKeyResolution {
  state: FormKeyResolutionState;
  recordType: string | null;
  editorId: string | null;
}

export type ConflictAll = 'OnlyOne' | 'NoConflict' | 'Override' | 'Conflict' | 'ConflictCritical';
export type ConflictThis = 'OnlyOne' | 'Master' | 'IdenticalToMaster' | 'Override' | 'ConflictWins' | 'ConflictLoses';

// #272 / ADR-0036: a compare-grid column is identified by (plugin, origin), not plugin alone —
// two columns can share a filename once #34 lands shadowed copies. `ColumnKey` is a branded
// string, minted only by `columnKey()` below, so every place that carries column identity
// (focusedCell, collapsedColumns, immutableSet, overrideMap's key, the drag source,
// addPropertyTarget — see DiffRow.tsx/RecordPanel.tsx) can be typed as `ColumnKey` rather than
// `string`: comparing it against a bare `plugin` string becomes a compile error instead of a
// silent same-filename collision. `Record<ColumnKey, T>`/`{ [k: string]: T }` still erase the
// brand (a mapped type over a non-literal string collapses to an index signature) — the
// per-column dictionaries on the wire (FieldDiff.values, VmadPropertyDiff.values, etc.) are not
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
// would mean the immutableSet/RecordSessionClient mismatch this guards against (two independently
// -fetched responses disagreeing only in case) trades for making every ColumnKey unreadable and
// disagreeing with the exact plugin string every existing caller already threads through
// (onFocusCell/onEdit/onCellDragStart/onCellDrop's payloads, action broadcasts) for no case-
// mismatch anyone has actually observed. The backend does not fold at all (see ColumnKey.Of's own
// doc comment) — this key is only ever used as an opaque local lookup key against JSON the backend
// produced, never sent back to it, so the two sides folding differently has no wire consequence.
//
// #275 / ADR-0036: `origin` is required (no longer omittable) — every hand type that feeds this
// (RecordDetail.origin, PluginInfo.origin) is a required `string` too, so a
// caller can no longer skip specifying it and silently collapse onto the elided Data origin.
//
// #272 review: `origin` still accepts a literal `null` value, even though every one of those hand
// types claims it never will be. Investigated: it provably can't be, today — the
// backend fields behind all three (`RecordDetail.Origin`/`CompareOverride.Origin`/
// `PluginResponse.Origin`, MEditService.Core/Queries/Models.cs and
// Session/PluginMetadata.cs) are non-nullable C# `string`s, always populated from
// `PluginOrigin.DataDirectory` or an already-normalized value (`SessionEndpoints.cs`'s
// `string.IsNullOrEmpty(p.Origin) ? PluginOrigin.DataDirectory : p.Origin` is the one place a
// nullable origin — `ExplicitPlugin.Origin`, a *request* shape, never returned to a client —
// exists at all, and it's resolved before touching any read-side DTO), and every one of those
// origin columns is `NOT NULL` in DuckDB, read via an unguarded `reader.GetString(...)` that would
// throw server-side rather than let a null through. The generated wire schema still types every
// one of these fields `string | null` regardless (`api.ts`'s `origin?: string | null` — an
// artifact of the OpenAPI generator not reading C# nullable-reference-type annotations, applied
// uniformly to every string field on the wire, not something specific to origin), and
// RecordSessionClient's `load()` casts that raw response straight into these hand types with an
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

export interface RecordDetail {
  formKey: string;
  plugin: string;
  loadOrderIndex: number;
  isWinner: boolean;
  editorId: string | null;
  fields: FieldValue[];
  // Issue #3: the schema table name (e.g. "npc_"), needed for "Copy as New Record" — CreateRecord
  // requires it up front. Optional so existing fixtures/callers don't break;
  // always populated by the real backend response.
  recordType?: string;
  // #272 / ADR-0036: the mod folder (or reserved PluginOrigin value) this override was resolved
  // from — parallel sibling to `plugin`, never parsed out of a ColumnKey (see columnKey()'s own
  // doc comment). Required (#275) — every construction must say which origin.
  origin: string;
}

export interface CompareOverride extends RecordDetail {
  conflictThis: ConflictThis;
}

// Issue #231: the chain from a row's own restage root (a plain reflected field, or a
// wirePath-bearing VMAD/Condition subtree — see FieldDiff.wirePath below) down to a given row's
// own value: a struct hop addressed by member name, an unsorted-array hop by position, a sorted
// (pure FormLink) array hop by the element's own value (there is nothing to address *beneath* a
// sortKey hop — a sorted array's elements are themselves the value, never a struct/array).
// #533: moved to src/medit/messages.ts — the shared module the extension host already imports
// directly (StringValueContext/FIELD_OPEN_EXTENDED_EDITOR now carry this too), so it can cross to
// the extension host without importing a webview type the wrong way. Re-exported here since every
// existing caller in this module (and recordUtils.ts's own re-export) already imports it from
// './types'.
export type { PathSegment } from './messages';

export interface FieldDiff {
  fieldName: string;
  values: Record<string, unknown>;
  winnerColumn: string;
  winnerValue: unknown;
  cellStates: Record<string, ConflictThis>;
  // Issue #114: this node's own bottom-up conflict classification (own cellStates folded with
  // every descendant's, recursively) — distinct from CompareResult.conflictAll (record-wide,
  // drives the Plugins-tree badge). Populated by the backend for an ordinary reflected field;
  // vmadTreeAdapter.ts/conditionTreeAdapter.ts compute it themselves for their own synthesized
  // nodes (see recordUtils.ts's aggregateConflictAll). Optional so a stale fixture/adapter that
  // hasn't set it degrades to "no background" (DiffRow's getRowBg) rather than crashing.
  conflictAll?: ConflictAll;
  children?: FieldDiff[] | null;
  // ADR-0031: only populated for a scalar formKey-typed leaf, keyed by plugin like values/
  // cellStates — never aggregated up from children, so a dangling sibling can't hide a live
  // hyperlink/affordance on the leaf next to it.
  resolutions?: Record<string, FormKeyResolution>;
  // Issue #231: the wire path this row (and every row in its subtree) stages under — decoupled
  // from `fieldName`, which stays a pure display label. Absent (defaulting to `fieldName`) for an
  // ordinary reflected field, where the two always coincide; set explicitly by the VMAD/Condition
  // tree adapters, whose rows display under a short name ("Health", "Function") but stage under a
  // longer wire path ("VMAD\ScriptA\Health", "CTDA\Conditions\0\Function") that the two frictions
  // in #231 ("wire paths differ") call out by name.
  wirePath?: string;
  // Issue #231 (review, design call): a per-plugin xEdit-style one-line prose summary
  // (`wbConditionToStr`, references/TES5Edit/Core/wbDefinitionsCommon.pas) for this row's
  // collapsed label — set only by conditionTreeAdapter.ts's condition rows, whose own values are
  // already the whole ParsedCondition object this formats. DiffRow shows this in place of a
  // struct row's generic "{…}" when present; absent (falling back to "{…}") for every ordinary
  // struct row and every VMAD struct row, which have no equivalent per-record-type formatting.
  collapsedSummary?: Record<string, string>;
}

export type VmadKind = 'scalar' | 'object' | 'array' | 'struct' | 'structList' | 'variable';

export interface VmadPropertyDiff {
  name: string;
  kind: VmadKind;
  values: Record<string, unknown>;        // leaf; "FormKey [Alias]" for object; null when has children/absent
  types: Record<string, string>;          // per-plugin property Type (can differ → conflict)
  winnerColumn: string;
  cellStates: Record<string, ConflictThis>;
  children?: VmadPropertyDiff[] | null;    // struct members (by name) / array elements (by index)
  raw?: Record<string, unknown> | null;    // struct/structList only: per-plugin editable node subtree (atomic column)
  // ADR-0031: only populated on a kind === 'object' leaf, keyed by plugin like values/cellStates —
  // never aggregated up from children. VMAD wiring lands in #158; the field exists here now so
  // the type matches the backend response shape.
  resolutions?: Record<string, FormKeyResolution>;
}

export interface VmadScriptDiff {
  name: string;
  flags: Record<string, string | null>;   // per-plugin script flags; null = script absent in that plugin
  winnerColumn: string;
  cellStates: Record<string, ConflictThis>;
  properties: VmadPropertyDiff[];
}

export interface VmadCompare {
  scripts: VmadScriptDiff[];
}

// Conditions (CTDA) — game-neutral parsed model (ADR-0032). One ParsedCondition per row; the
// section renders its xEdit-style summary and expands to these typed fields.
export type ConditionOperator =
  | 'EqualTo' | 'NotEqualTo' | 'GreaterThan' | 'GreaterThanOrEqualTo' | 'LessThan' | 'LessThanOrEqualTo';

export type ConditionParamCategory = 'Number' | 'Form' | 'Text';

export interface ParsedConditionParam {
  category: ConditionParamCategory;
  typeName: string;                        // ParameterType name, e.g. "ActorValue" — display cue
  number?: number | null;
  formKey?: string | null;
  text?: string | null;
  decodedValue?: string | null;            // #165: Number param's enum member name (e.g. "Male"), when known
}

export interface ParsedCondition {
  function: string;
  operator: ConditionOperator;
  or: boolean;                             // true = OR, false = AND
  runOnTarget: string;                     // "Subject" | "Target" | "Reference" | ...
  runOnReference?: string | null;          // FormKey when runOnTarget === "Reference"
  useGlobal: boolean;
  comparisonFloat?: number | null;
  comparisonGlobal?: string | null;        // GLOB FormKey when useGlobal
  parameters: ParsedConditionParam[];
}

export interface ConditionDiff {
  index: number;
  perPlugin: Record<string, ParsedCondition | null>;   // null = plugin lacks this condition row
  winnerColumn: string;
  cellStates: Record<string, ConflictThis>;            // whole-condition state (summary row)
  // Per-field two-axis states for the expanded view, keyed by field id ("function", "operator",
  // "gate", "runOn", "comparison", "param:{i}") — only the field that differs is colored.
  fieldCellStates: Record<string, Record<string, ConflictThis>>;
  // #166: FormKey→EditorID resolution (ADR-0031) for a condition's three FormKey-bearing slots —
  // keyed like fieldCellStates ("runOn", "comparison", "param:{i}"; never "function"/"operator"/
  // "gate"), then by plugin. Absent when the field carries no FormKey for that plugin (e.g. runOn
  // isn't Reference, or useGlobal is false).
  fieldResolutions?: Record<string, Record<string, FormKeyResolution>>;
}

export interface ConditionGroupDiff {
  fieldPath: string;
  conditions: ConditionDiff[];
}

export interface ConditionCompare {
  groups: ConditionGroupDiff[];
}

export interface CompareResult {
  overrides: CompareOverride[];
  diffs: FieldDiff[];
  conflictAll: ConflictAll;
  // Issue #179: schema-level capability ("can this record type ever carry VMAD at all",
  // reflected from Mutagen's IHaveVirtualMachineAdapterGetter) — distinct from `vmad` below,
  // which is per-record *data* and is null/absent for a VMAD-capable record that simply has no
  // scripts yet. Gates whether RecordPanel renders a Scripts (VMAD) section at all.
  hasVmad: boolean;
  vmad?: VmadCompare | null;
  conditions?: ConditionCompare | null;
}

