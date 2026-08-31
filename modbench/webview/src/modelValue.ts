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

export type CoerceResult = { ok: true; value: unknown } | { ok: false };

// ADR-0034: the inverse of modelValue above — given the string Ctrl+V's clipboard
// carries (or '' for Ctrl+X's own clear, which commits through this same pipeline rather than a
// bespoke per-type default — the "leave unchanged if it can't coerce" rule, applied
// to cut too), recovers the value modelValue would have produced it from. `{ ok: false }` is
// "cannot coerce, leave the field unchanged" — never a thrown error and never a guessed fallback
// value; DiffRow's paste/cut handlers simply don't commit when they see it. This is what makes
// paste/cut share the *same* coercion the typed-editor commit path already applies, rather than a
// second implementation that merely happens to agree with modelValue today.
//
// formKey only ever accepts '' (Ctrl+X's clear — no reference needs no resolution); any other
// text is `{ ok: false }` here, not attempted resolution against the record index. DiffRow never
// calls this for formKey's Ctrl+V at all (unwired by design — see DiffRow's computeClipboardOps):
// the QuickPick opened by F2/second-click/double-click is already a native input that accepts a
// pasted "EditorID [FormKey]" composite and normalizes/resolves it before commit, so a
// second, headless resolve-from-clipboard path here would be a second route to the same outcome,
// not a new capability.
//
// struct/array return `{ ok: false }` unconditionally — a compound field has no direct commit path
// today (it's edited through its child rows, never as a unit; the summary-row cell DiffRow renders
// for one carries no onCommit at all) — never actually reached, since DiffRow doesn't wire
// onCut/onPaste there either.
export function coerceModelValue(text: string, meta: FieldMetadata): CoerceResult {
  switch (meta.type) {
    case 'bool':
      if (text === 'true') return { ok: true, value: true };
      if (text === 'false') return { ok: true, value: false };
      return { ok: false };
    case 'int': {
      const n = parseInt(text, 10);
      return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
    }
    case 'float': {
      const n = parseFloat(text);
      return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
    }
    case 'enum':
      if (meta.isBitmask && meta.enumBitValues) {
        if (text === '') return { ok: true, value: '0' };
        const names = text.split(', ');
        if (!names.every(n => meta.enumValues.includes(n))) return { ok: false };
        const bits = names.reduce((acc, n) => acc | BigInt(meta.enumBitValues![meta.enumValues.indexOf(n)]), 0n);
        return { ok: true, value: bits.toString() };
      }
      // A plain <select> only ever offers meta.enumValues, so a pasted name has to match one of
      // them exactly to be a legitimate value; an enum with no declared values (never seen from
      // the real backend, but ScalarCell's generic <input> branch already treats it as free text)
      // accepts anything, for the same reason.
      return meta.enumValues.length === 0 || meta.enumValues.includes(text)
        ? { ok: true, value: text }
        : { ok: false };
    case 'formKey':
      return text === '' ? { ok: true, value: '' } : { ok: false };
    case 'struct':
    case 'array':
      return { ok: false };
    default:
      return { ok: true, value: text };
  }
}
