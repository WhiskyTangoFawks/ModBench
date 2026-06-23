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

export interface CompareResult {
  overrides: CompareOverride[];
  diffs: FieldDiff[];
  conflictAll: ConflictAll;
  vmad?: VmadCompare | null;
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
}
