import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import { isFieldType, type FieldMetadata, type FormKeyResolution } from './types';

// ADR-0018: one definition of a cell's edit value, so the readout and what Ctrl+C copies cannot
// drift from the editor. Struct/array is JSON, not xEdit's prose summary, because an edit value
// must round-trip.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
  if (isFieldType(meta.type)) {
    switch (meta.type) {
      case 'formKey':
        return typeof value === 'string' && value ? formKeyLabel(value, resolution) : '';
      case 'flags':
        return flagNames(value).join(', ');
      case 'translatedString':
        return toStr(translatedText(value));
      case 'struct':
      case 'array':
        return JSON.stringify(value);
      case 'bool':
        return value ? 'True' : 'False';
      case 'string':
      case 'int':
      case 'float':
      case 'enum':
      case 'hex':
      case 'color':
      case 'vector':
        return toStr(value);
    }
  }
  // The wire's field type is a string, and the backend may send one this union does not yet name.
  return toStr(value);
}

const memberOf = (value: unknown, meta: FieldMetadata) => meta.enumMembers.find(m => m.value === String(value));

// Differs from the edit value only for an enum: a member whose values are wire tokens rather than
// words (an abstract union's `MutagenObjectType` carries Mutagen class names) shows its label, and
// a value the enum does not name reads `<Unknown: n>`.
export function displayValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (meta.type !== 'enum' || value == null || meta.enumMembers.length === 0) {
    return modelValue(value, meta, resolution);
  }
  const member = memberOf(value, meta);
  return member ? member.label ?? modelValue(value, meta) : `<Unknown: ${modelValue(value, meta)}>`;
}

// What Ctrl+C takes: the reading, except an unnamed enum value, which copies as the value the
// editor can take back.
export function copiedText(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  const unnamed = meta.type === 'enum' && value != null && meta.enumMembers.length > 0 && !memberOf(value, meta);
  return unnamed ? modelValue(value, meta) : displayValue(value, meta, resolution);
}

// The codec spells a flags member as the array of the names that are set; absent means none.
export function flagNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// The codec spells a translated string as an object whose `Value` is the text.
export function translatedText(value: unknown): string | undefined {
  const text = (value as { Value?: unknown } | null | undefined)?.Value;
  return typeof text === 'string' ? text : undefined;
}
