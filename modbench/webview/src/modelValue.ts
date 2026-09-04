import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import type { FieldMetadata, FormKeyResolution } from './types';

// ADR-0034: the single definition of "the value a cell's editor holds" per field type — xEdit's
// `Element.EditValue`. ScalarCell's draft and FlagCell's checkbox state are sourced from it, and
// `displayValue` below is the one place that turns it into what the cell reads out, so what the
// user sees and what Ctrl+C copies cannot drift from each other or from the editor.
//
// FormKey stays a thin dispatch onto `formKeyLabel` (the shared composite builder, also used
// directly by FormKeyCell/FormKeyLink) rather than being reimplemented here — there is only one
// function that knows how to build "EditorID [FormKey]", and this just calls it.
//
// Struct/array is a deliberate divergence from xEdit's own `Element.Summary`: JSON serialization
// of the field's current value, not a per-record-type human-readable summary. This is the edit
// value and what Ctrl+C hands over, so it is the shape that has to round-trip (`JSON.parse`
// recovers the same value); a prose summary does not. xEdit's own prose lives in the presentation
// table (presentation.ts) instead, which the grid renders on a collapsed row and which claims
// nothing about round-tripping.
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

// What the cell reads out. Identical to the edit value except for an enum whose own values are wire
// tokens rather than words (an abstract union's `concrete_type` carries Mutagen class names), where
// the member carries the label to show in its place.
export function displayValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (meta.type !== 'enum' || flagBits(meta) != null) return modelValue(value, meta, resolution);
  return meta.enumMembers.find(m => m.value === String(value))?.label ?? modelValue(value, meta);
}

// The bit each member stands for, or null when this field is not a set of flags — which is exactly
// "every member carries a bit". The one answer to "does this render as checkboxes?", so DiffRow's
// routing, modelValue's flags branch and FlagCell's checkbox state cannot disagree.
export function flagBits(meta: FieldMetadata): { value: string; bit: bigint }[] | null {
  const bits: { value: string; bit: bigint }[] = [];
  for (const m of meta.enumMembers) {
    if (m.bitValue == null) return null;
    bits.push({ value: m.value, bit: BigInt(m.bitValue) });
  }
  return bits.length > 0 ? bits : null;
}

// Bitmask values arrive as decimal strings
// (the backend's contract — see Models.cs) so combined flags above 2^53 survive JSON without
// IEEE 754 loss; numbers are still accepted for small values. Anything else (or a malformed
// string) yields 0n rather than throwing on BigInt(NaN).
export function toBigInt(value: unknown): bigint {
  try {
    if (typeof value === 'string') return BigInt(value);
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  } catch {
    /* malformed numeric string — fall through to 0n */
  }
  return 0n;
}
