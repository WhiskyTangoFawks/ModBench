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
// of the field's current value, not a per-record-type human-readable summary. A faithful
// `Element.Summary` equivalent needs domain knowledge this codebase doesn't have anywhere yet
// (how to render a REFR's position, a condition's function call, an arbitrary nested struct) and
// would be its own open-ended design effort.
// JSON needs no per-type knowledge, is honest about what a struct/array actually is, and is
// genuinely round-trippable (`JSON.parse` recovers the same value) — a prose summary is neither.
export function modelValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (value == null) return '';
  switch (meta.type) {
    case 'formKey':
      return typeof value === 'string' && value ? formKeyLabel(value, resolution) : '';
    case 'enum':
      if (meta.isBitmask && meta.enumBitValues) {
        const num = toBigInt(value);
        const bits = meta.enumBitValues.map(BigInt);
        return meta.enumValues.filter((_, i) => (num & bits[i]) !== 0n).join(', ');
      }
      return toStr(value);
    case 'struct':
    case 'array':
      return JSON.stringify(value);
    default:
      return toStr(value);
  }
}

// What the cell reads out. Identical to the edit value except for an enum whose own values are wire
// tokens rather than words (an abstract union's `concrete_type` carries Mutagen class names), where
// the schema labels each value — positionally, the same alignment enumBitValues already uses.
export function displayValue(value: unknown, meta: FieldMetadata, resolution?: FormKeyResolution): string {
  if (meta.type !== 'enum' || meta.isBitmask) return modelValue(value, meta, resolution);
  return meta.enumLabels?.[meta.enumValues.indexOf(String(value))] ?? modelValue(value, meta);
}

// Shared by modelValue's own flags branch and FlagCell's checkbox-state
// computation — one BigInt parse, not two. Bitmask values arrive as decimal strings
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
