import { describe, it, expect } from 'vitest';
import { columnKey } from '../columnKey';

describe('columnKey agrees with the backend\'s ColumnKey.Of for the same plugin', () => {
  it('the same filename under two different origins produces two distinct keys', () => {
    expect(columnKey({ name: 'Shared.esp', origin: 'ModA' })).not.toBe(columnKey({ name: 'Shared.esp', origin: 'ModB' }));
  });

  it('elides the reserved Data origin to the plain filename, not `filename|Data`, in its own original casing, matching the backend exactly', () => {
    expect(columnKey({ name: 'Shared.esp', origin: 'Data' })).toBe('Shared.esp');
  });

  it('case-folds the Data-origin check itself, however the origin is cased', () => {
    expect(columnKey({ name: 'Shared.esp', origin: 'DATA' })).toBe('Shared.esp');
  });

  it('a non-Data origin appends after the delimiter, preserving both halves\' own casing', () => {
    expect(columnKey({ name: 'Shared.esp', origin: 'ModA' })).toBe('Shared.esp|ModA');
  });
});
