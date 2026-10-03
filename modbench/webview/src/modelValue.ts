import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import { isFieldType, type FieldMetadata, type FormKeyResolution } from './types';

// One definition of a cell's edit value, so the readout and what Ctrl+C copies cannot drift from
// the editor (editor-fields.md, Every field, story 4). Struct/array is JSON, not xEdit's prose summary, because an edit value
// must round-trip.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
  if (isFieldType(meta.type)) {
    switch (meta.type) {
      case 'formKey':
        return typeof value === 'string' && value ? formKeyLabel(value, resolution) : '';
      case 'flags':
        return flagNames(value, meta).join(', ');
      case 'int':
        return readsAsFlags(meta) ? flagNames(value, meta).join(', ') : toStr(value);
      case 'translatedString':
        return toStr(translatedText(value));
      case 'struct':
      case 'array':
        return JSON.stringify(value);
      case 'bool':
        return value === true ? 'True' : 'False';
      case 'string':
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

/** A flags member, or an integer whose bits the schema names, as the record header's flags are. */
export function readsAsFlags(meta: FieldMetadata): boolean {
  return meta.type === 'flags' || (meta.type === 'int' && meta.enumMembers.length > 0);
}

const bitOf = (name: string, meta: FieldMetadata): number | undefined => {
  const named = meta.enumMembers.find(m => m.value === name)?.bitValue;
  if (named != null) return Number(named) | 0;
  return /^0x[0-9a-f]+$/i.test(name) ? Number(name) | 0 : undefined;
};

const hexOf = (bit: number) => `0x${(bit >>> 0).toString(16).toUpperCase()}`;

// The codec spells a flags member as the array of the names that are set; an integer's bits read
// by the names the schema gives them, and an unnamed bit as the codec spells one. Absent means none.
export function flagNames(value: unknown, meta: FieldMetadata): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'number') return [];
  let unnamed = value | 0;
  const names = meta.enumMembers.filter(m => {
    const bit = Number(m.bitValue) | 0;
    if (bit === 0 || (unnamed & bit) === 0) return false;
    unnamed &= ~bit;
    return true;
  }).map(m => m.value);
  for (let bit = 1; unnamed !== 0; bit <<= 1) {
    if ((unnamed & bit) !== 0) names.push(hexOf(bit));
    unnamed &= ~bit;
  }
  return names;
}

/** The names set, as the member spells them: the names themselves, or the integer their bits make,
 *  as the signed 32-bit value the member holds. Undefined for a name the schema does not give. */
export function flagsValue(names: readonly string[], meta: FieldMetadata): unknown {
  if (meta.type === 'flags') return [...names];
  let bits = 0;
  for (const name of names) {
    const bit = bitOf(name, meta);
    if (bit === undefined) return undefined;
    bits |= bit;
  }
  return bits;
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
  const names = trimmed === '' ? [] : trimmed.split(',').map(name => name.trim());
  switch (meta.type) {
    case 'bool': {
      const word = trimmed.toLowerCase();
      return word === 'true' || word === 'false' ? word === 'true' : text;
    }
    case 'int': {
      if (readsAsFlags(meta)) return flagsValue(names, meta) ?? text;
      const whole = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : NaN;
      return Number.isSafeInteger(whole) ? whole : text;
    }
    case 'float': {
      const number = DECIMAL_NUMBER.test(trimmed) ? Number(trimmed) : NaN;
      return Number.isFinite(number) ? number : text;
    }
    case 'enum': return enumValueNamed(trimmed, meta);
    case 'flags': return names;
    case 'formKey': return trimmed === '' ? null : BRACKETED_FORM_KEY.exec(trimmed)?.[1] ?? trimmed;
    case 'struct':
    case 'array': return parsedJson(text);
    case 'translatedString': return withTranslatedText(current, text);
    default: return text;
  }
}
