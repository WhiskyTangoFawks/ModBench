import { toStr } from './recordUtils';
import { formKeyLabel } from './FormKeyLink';
import type { FieldMetadata, FormKeyResolution } from './types';

// ADR-0034: the single definition of "the string a cell's editor shows" per field
// type — xEdit's `Element.EditValue`. Ctrl+C copies exactly this string (DiffRow), and it is also
// what ScalarCell/FlagCell source their own display/draft text from, so copy and the editor can
// never drift apart — there is nothing here to keep in sync, only one place that knows.
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
