import { describe, it, expect } from 'vitest';
import { columnKey } from '../columnKey';

describe('columnKey agrees with the backend\'s ColumnKey.Of for the same plugin', () => {
  it('the same filename under two different origins produces two distinct keys', () => {
    expect(columnKey({ name: 'Shared.esp', origin: 'ModA' })).not.toBe(columnKey({ name: 'Shared.esp', origin: 'ModB' }));
  });

  it.each([
    ['the Data origin elides to the filename in its own casing', 'Data/', 'Shared.esp'],
    ['the Data origin elides however it is cased', 'DATA/', 'Shared.esp'],
    ['any other origin follows the delimiter, both halves in their own casing', 'ModA', 'Shared.esp|ModA'],
  ])('%s', (_, origin, key) => {
    expect(columnKey({ name: 'Shared.esp', origin })).toBe(key);
  });
});
