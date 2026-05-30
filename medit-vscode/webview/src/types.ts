export interface FieldMetadata {
  name: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'enum' | 'formKey' | 'struct' | 'array';
  isArray: boolean;
  validFormKeyTypes: string[];
  enumValues: string[];
}

export interface FieldValue {
  metadata: FieldMetadata;
  value: unknown;
}

export interface RecordDetail {
  formKey: string;
  plugin: string;
  loadOrderIndex: number;
  isWinner: boolean;
  editorId: string | null;
  fields: FieldValue[];
  pendingFields?: Record<string, unknown>;
}

export interface FieldDiff {
  fieldName: string;
  values: Record<string, unknown>;
  isConflict: boolean;
  winnerPlugin: string;
  winnerValue: unknown;
}

export interface CompareResult {
  overrides: RecordDetail[];
  diffs: FieldDiff[];
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
