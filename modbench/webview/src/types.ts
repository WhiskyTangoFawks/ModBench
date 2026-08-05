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

export interface RecordDetail {
  formKey: string;
  plugin: string;
  loadOrderIndex: number;
  isWinner: boolean;
  editorId: string | null;
  fields: FieldValue[];
  pendingFields?: Record<string, unknown>;
  // Issue #3: the schema table name (e.g. "npc_"), needed for "Copy as New Record" — CreateRecord
  // requires it up front. Optional (like pendingFields) so existing fixtures/callers don't break;
  // always populated by the real backend response.
  recordType?: string;
}

export interface CompareOverride extends RecordDetail {
  conflictThis: ConflictThis;
}

// Issue #231: the chain from a row's own restage root (a plain reflected field, or a
// wirePath-bearing VMAD/Condition subtree — see FieldDiff.wirePath below) down to a given row's
// own value: a struct hop addressed by member name, an unsorted-array hop by position, a sorted
// (pure FormLink) array hop by the element's own value (there is nothing to address *beneath* a
// sortKey hop — a sorted array's elements are themselves the value, never a struct/array). Defined
// here (not recordUtils.ts, where its own getAtPath/setAtPath live) because FieldDiff.commitOverride
// needs the type too, and types.ts is the lower-level of the two modules — recordUtils.ts re-exports
// it for every existing caller.
export type PathSegment =
  | { kind: 'member'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'sortKey'; key: string };

export interface FieldDiff {
  fieldName: string;
  values: Record<string, unknown>;
  winnerPlugin: string;
  winnerValue: unknown;
  cellStates: Record<string, ConflictThis>;
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
  // Issue #231: the write-side analog of `wirePath`, needed only where the *staged value's own
  // shape* also differs from the unified tree's plain nested-object/array model — currently just
  // VMAD's Struct/ArrayOfStruct properties, whose wire value is the backend's raw node format
  // (VmadStructEntry[]/VmadStructInstance[]: `{name, type, boolValue, ..., members}`), unchanged
  // by this issue (no backend/API change). A plain nested object/array (every ordinary field,
  // every Condition field, and VMAD's own scalar/object/array-of-scalar properties) never sets
  // this — RecordPanel's generic `setAtPath` (recordUtils.ts) already produces the right shape for
  // all of those. Present only on a `wirePath`-bearing root; called with the root's own current
  // (pending-or-disk) raw value, this row's path within it, and the new leaf value, and must
  // return the new raw root value to stage — the one place a subtree's commit mechanics can
  // differ from the shared default without a second row/cell renderer existing to hide it in.
  commitOverride?: (currentRaw: unknown, path: PathSegment[], value: unknown) => unknown;
  // Issue #231: marks a row as a target for VMAD's own structural (named-op) commands — Add/
  // Remove Script live on the "Scripts (VMAD)" wrapper/a script row; Add/Remove Property on a
  // script/property row — reached the same way every other structural op is (the right-click
  // menu), consistent with array operations. RecordPanel derives each command's own identity
  // from this row's own `fieldName` (a script/wrapper row's own name) or `wirePath`
  // (`parseVmadPath`, vmadOps.ts — a property row's own `VMAD\Script\Prop`) rather than this field
  // carrying it directly, so the adapter that sets it stays a plain marker, not a second copy of
  // that identity. Absent for every ordinary/Condition row.
  vmadOpKind?: 'scripts' | 'script' | 'property';
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
  winnerPlugin: string;
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
  winnerPlugin: string;
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
  winnerPlugin: string;
  cellStates: Record<string, ConflictThis>;            // whole-condition state (summary row)
  // Per-field two-axis states for the expanded view, keyed by field id ("function", "operator",
  // "gate", "runOn", "comparison", "param:{i}") — only the field that differs is colored.
  fieldCellStates: Record<string, Record<string, ConflictThis>>;
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

export interface PendingChange {
  id: string;
  formKey: string;
  plugin: string;
  fieldPath: string;
  recordType: string;
  oldValue: unknown;
  newValue: unknown;
  source: string;
  description: string | null;
  changedAt: string;
  // ADR-0031: resolution signal for every FormKey-typed value inside newValue, keyed by the
  // sub-path within newValue ("" for a scalar formKey field itself, matching FormRefPathBuilder).
  resolutions?: Record<string, FormKeyResolution>;
  // ADR-0031 / #159: resolution signal for the change's own FormKey (record identity) — distinct
  // from `resolutions` above, which is scoped to leaves inside newValue. Drives the Pending
  // Changes tree's `{RecordType} / {EditorID}` leaf label.
  recordResolution?: FormKeyResolution;
}

export interface ReferenceValidationError {
  fieldPath: string;
  value?: string;
  reason?: 'not_in_session' | 'not_append_only' | 'type_mismatch' | 'null_not_allowed';
  expectedTypes?: string[];
}

// #147: PATCH /records/{formKey}'s single 422 shape — fieldErrors for reference/append-only/
// type-mismatch/null-not-allowed failures, detail for everything else (ESL-ineligible, read-only
// fields). Never both. Mirrors the backend's PatchRecordValidationError envelope.
export interface PatchRecordValidationError {
  fieldErrors?: ReferenceValidationError[] | null;
  detail?: string | null;
}
