import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import type { FieldMetadata, FormKeyResolution } from './types';

// ADR-0034: one definition of a cell's edit value, so the readout and what Ctrl+C copies cannot
// drift from the editor. Struct/array is JSON, not xEdit's prose summary, because an edit value
// must round-trip.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
  switch (meta.type) {
    case 'formKey':
      return typeof value === 'string' && value ? formKeyLabel(value, resolution) : '';
    case 'enum': {
      const flags = flagBits(meta);
      if (flags) {
        const num = toBigInt(value);
        return flags.filter(f => (num & f.bit) !== 0n).map(f => f.value).join(', ');
      }
      return toStr(value);
    }
    case 'struct':
    case 'array':
      return JSON.stringify(value);
    default:
      return toStr(value);
  }
}

// Differs from the edit value only for an enum whose values are wire tokens rather than words (an
// abstract union's `concrete_type` carries Mutagen class names); the member's label shows instead.
export function displayValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (meta.type !== 'enum' || flagBits(meta) != null) return modelValue(value, meta, resolution);
  return meta.enumMembers.find(m => m.value === String(value))?.label ?? modelValue(value, meta);
}

// Null unless every member carries a bit. The one answer to "does this render as checkboxes?", so
// routing, flag formatting and checkbox state cannot disagree.
export function flagBits(meta: FieldMetadata): { value: string; bit: bigint }[] | null {
  const bits: { value: string; bit: bigint }[] = [];
  for (const m of meta.enumMembers) {
    if (m.bitValue == null) return null;
    bits.push({ value: m.value, bit: BigInt(m.bitValue) });
  }
  return bits.length > 0 ? bits : null;
}

// Bitmask values arrive as decimal strings so combined flags above 2^53 survive JSON without
// IEEE 754 loss. Anything malformed yields 0n rather than throwing on BigInt(NaN).
export function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'string') return BigInt(value);
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  } catch {
    /* malformed numeric string — fall through to 0n */
  }
  return 0n;
}
