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
        return value === true ? 'True' : 'False';
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

// Differs from the edit value only for an enum: a wire-token member shows its label, and a value
// the enum does not name reads `<Unknown: n>`.
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

// The codec's own spelling of a translated string, with only its text changed.
function withTranslatedText(current: unknown, text: string): object {
  return { ...(typeof current === 'object' ? current : null), Value: text };
}

const WHOLE_NUMBER = /^[+-]?\d+$/;
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BRACKETED_FORM_KEY = /\[([^\]]+)\]\s*$/;

function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function enumValueNamed(text: string, meta: FieldMetadata): string {
  return meta.enumMembers.find(m => m.label === text || m.value === text)?.value ?? text;
}

/** The inverse of `copiedText`: pasted text as the field's own value. Text the field cannot hold
 *  stays text, so mEdit refuses it by the field's name rather than this repairing it. */
export function pastedValue(text: string, meta: FieldMetadata, current: unknown): unknown {
  const trimmed = text.trim();
  switch (meta.type) {
    case 'bool': {
      const word = trimmed.toLowerCase();
      return word === 'true' || word === 'false' ? word === 'true' : text;
    }
    case 'int': {
      const whole = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : NaN;
      return Number.isSafeInteger(whole) ? whole : text;
    }
    case 'float': {
      const number = DECIMAL_NUMBER.test(trimmed) ? Number(trimmed) : NaN;
      return Number.isFinite(number) ? number : text;
    }
    case 'enum': return enumValueNamed(trimmed, meta);
    case 'flags': return trimmed === '' ? [] : trimmed.split(',').map(name => name.trim());
    case 'formKey': return trimmed === '' ? null : BRACKETED_FORM_KEY.exec(trimmed)?.[1] ?? trimmed;
    case 'struct':
    case 'array': return parsedJson(text);
    case 'translatedString': return withTranslatedText(current, text);
    default: return text;
  }
}
