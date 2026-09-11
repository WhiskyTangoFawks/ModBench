import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import type { FieldMetadata, FormKeyResolution } from './types';

// ADR-0018: one definition of a cell's edit value, so the readout and what Ctrl+C copies cannot
// drift from the editor. Struct/array is JSON, not xEdit's prose summary, because an edit value
// must round-trip.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
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
    default:
      return toStr(value);
  }
}

// Differs from the edit value only for an enum whose values are wire tokens rather than words (an
// abstract union's `MutagenObjectType` carries Mutagen class names); the member's label shows instead.
export function displayValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (meta.type !== 'enum') return modelValue(value, meta, resolution);
  return meta.enumMembers.find(m => m.value === String(value))?.label ?? modelValue(value, meta);
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
