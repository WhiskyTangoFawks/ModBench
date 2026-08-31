// Frontend mirror of the backend's ConditionPath (MEditService.Core/Edits/ConditionPath.cs) — the
// wire contract for a condition scalar-field edit: "CTDA\<FieldPath>\<Index>\<SubField>". Single
// source on this side so every condition editor builds the same path shape the backend parses.
export function conditionFieldPath(fieldPath: string, index: number, subField: string): string {
  return `CTDA\\${fieldPath}\\${index}\\${subField}`;
}

export function conditionParamPath(fieldPath: string, index: number, paramIndex: number): string {
  return conditionFieldPath(fieldPath, index, `Parameter\\${paramIndex}`);
}
