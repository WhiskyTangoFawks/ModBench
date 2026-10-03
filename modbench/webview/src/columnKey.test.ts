import { describe, it, expect } from 'vitest';
import { columnKey } from './columnKey';

describe('columnKey agrees with the backend\'s ColumnKey.Of for the same (plugin, origin) pair', () => {
  it('the same plugin and origin always produce the same key', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe(columnKey('Shared.esp', 'ModA'));
  });

  it('the same filename under two different origins produces two distinct keys', () => {
    expect(columnKey('Shared.esp', 'ModA')).not.toBe(columnKey('Shared.esp', 'ModB'));
  });

  it('elides the reserved Data origin to the plain filename, not `filename|Data`, in its own original casing, matching the backend exactly', () => {
    expect(columnKey('Shared.esp', 'Data')).toBe('Shared.esp');
  });

  it('case-folds the Data-origin check itself, however the origin is cased', () => {
    expect(columnKey('Shared.esp', 'DATA')).toBe(columnKey('Shared.esp', 'data'));
    expect(columnKey('Shared.esp', 'DATA')).toBe('Shared.esp');
  });

  it('a non-Data origin appends after the delimiter, preserving both halves\' own casing', () => {
    expect(columnKey('Shared.esp', 'ModA')).toBe('Shared.esp|ModA');
  });

  it('treats a literal null origin, which the wire schema\'s `string | null` lets through parseCompareResult\'s downcast and which is the only way to elide Data as origin is not omittable, the same as the Data origin, not a crash in `.toLowerCase()`', () => {
    expect(columnKey('Shared.esp', null)).toBe(columnKey('Shared.esp', 'Data'));
    expect(columnKey('Shared.esp', null)).toBe('Shared.esp');
  });
});
