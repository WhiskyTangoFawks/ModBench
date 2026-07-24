export interface FieldMetadata {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'enum' | 'formKey' | 'struct' | 'array';
  isArray: boolean;
  validFormKeyTypes: string[];
  enumValues: string[];
  elementType?: FieldMetadata;   // present when type === 'array'
  fields?: FieldMetadata[];       // present when type === 'struct'
  isSortable?: boolean;           // on elementType: true for pure FormLink arrays
  isBitmask?: boolean;            // true when the C# enum has [Flags]
  enumBitValues?: string[];       // present iff isBitmask; decimal string bit values aligned with enumValues
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
