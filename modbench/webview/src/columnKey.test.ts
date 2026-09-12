import { describe, it, expect } from 'vitest';
import { columnKey } from './columnKey';

// ADR-0012: columnKey() must agree with the backend's ColumnKey.Of for the same (plugin,
// origin) pair. With one origin per filename almost any implementation looks green; the red
// case is two columns sharing a filename but differing in origin.
describe('columnKey', () => {
  it('the same plugin and origin always produce the same key', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe(columnKey('Shared.esp', 'ModA'));
  });

  it('the same filename under two different origins produces two distinct keys', () => {
    expect(columnKey('Shared.esp', 'ModA')).not.toBe(columnKey('Shared.esp', 'ModB'));
  });

  // Elision parity with the backend: a Data-resolved plugin's key is the plain filename, not
  // `filename|Data`, in its own original casing.
  it('elides the reserved Data origin, matching the backend exactly', () => {
    expect(columnKey('Shared.esp', 'Data')).toBe('Shared.esp');
  });

  // ADR-0012: origin is not omittable, so a literal `null` is the only way to elide Data.

  // Case-folding is scoped to the Data-origin check only: "Data"/"data"/"DATA" must elide the
  // same way whichever casing a response uses.
  it('case-folds the Data-origin check itself, however the origin is cased', () => {
    expect(columnKey('Shared.esp', 'DATA')).toBe(columnKey('Shared.esp', 'data'));
    expect(columnKey('Shared.esp', 'DATA')).toBe('Shared.esp');
  });

  it('a non-Data origin appends after the delimiter, preserving both halves\' own casing', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe('Shared.esp|ModA');
  });

  // The generated wire schema types `origin` as `string | null`, and a null reaches these types
  // through parseCompareResult's downcast whatever they claim, so `columnKey` must tolerate it
  // like the elided Data origin rather than throw inside `.toLowerCase()`.
  it('treats a literal null origin the same as the Data origin, not a crash', () => {
    expect(columnKey('Shared.esp', null)).toBe(columnKey('Shared.esp', 'Data'));
    expect(columnKey('Shared.esp', null)).toBe('Shared.esp');
  });
});
