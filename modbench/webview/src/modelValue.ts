import { isString } from '../../src/wire/messages';
import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import { isFieldType } from './fieldType';
import type { FieldMetadata, FormKeyResolution } from './types';

// One definition of a cell's edit value, so the readout and what Ctrl+C copies cannot drift from
// the editor (editor-fields.md, Every field, story 4). Struct/array is JSON, because an edit value
// must round-trip.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
  if (isFieldType(meta.type)) {
    switch (meta.type) {
      case 'formKey':
        return isString(value) && value ? formKeyLabel(value, resolution) : '';
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
      case 'color':
        return colorReading(toStr(value), meta.holdsAlpha);
      case 'string':
      case 'float':
      case 'enum':
      case 'hex':
      case 'vector':
        return toStr(value);
    }
  }
  // The wire's field type is a string, and the backend may send one this union does not yet name.
  return toStr(value);
}

// The codec spells a color "#AARRGGBB", or "#RRGGBB" for an opaque one; it reads with its alpha
// only where its binary form holds one (editor-fields.md, By type).
function colorReading(text: string, holdsAlpha: boolean): string {
  const hex = /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1]?.toUpperCase();
  if (hex === undefined) return text;
  const argb = hex.length === 6 ? `FF${hex}` : hex;
  return `#${holdsAlpha ? argb : argb.slice(2)}`;
}

/** The CSS colour of a colour reading, or null where the reading is not a colour. */
export function colourOf(reading: string): string | null {
  const hex = /^#([0-9A-F]{6}|[0-9A-F]{8})$/.exec(reading)?.[1];
  if (hex === undefined) return null;
  const argb = hex.length === 6 ? `FF${hex}` : hex;
  const byte = (i: number) => parseInt(argb.slice(i, i + 2), 16);
  const [a, r, g, b] = [byte(0), byte(2), byte(4), byte(6)];
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a / 255})`;
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

// The codec spells a translated string as an object whose `Value` is the text; an edit spells it
// as the text alone.
function translatedText(value: unknown): string | undefined {
  const text = isString(value) ? value : (value as { Value?: unknown } | null | undefined)?.Value;
  return isString(text) ? text : undefined;
}

type HeldText = { Language?: unknown; String?: unknown };

/** A value as its cell shows it: a translated string as its text in `stringsLanguage`, as mEdit's views read it,
 *  its one text, else the text it holds in that language. The codec spells several languages as `Values`. */
export function shownValue(value: unknown, meta: FieldMetadata, stringsLanguage: string): unknown {
  if (meta.type !== 'translatedString') return value;
  const values = (value as { Values?: unknown } | null | undefined)?.Values;
  const held = Array.isArray(values) ? (values as HeldText[]).find(entry => entry.Language === stringsLanguage)?.String : undefined;
  return translatedText(value) ?? (isString(held) ? held : '');
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
export function pastedValue(text: string, meta: FieldMetadata): unknown {
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
    default: return text;
  }
}

/** The degrees of a rotation's radians reading "x, y, z", or null where the reading is not three numbers. */
export function degreesOf(reading: string): string | null {
  const parts = reading.split(',').map(part => Number(part.trim()));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  const degrees = parts.map(radians => Number(((radians * 180) / Math.PI).toFixed(4)));
  return `(${degrees.map(d => `${d}°`).join(', ')})`;
}
