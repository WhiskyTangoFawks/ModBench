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

export interface CompareResult {
  overrides: CompareOverride[];
  diffs: FieldDiff[];
  conflictAll: ConflictAll;
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
