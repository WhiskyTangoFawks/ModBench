import { describe, it, expect } from 'vitest';
import { recordLabel } from '../recordLabel';

describe('recordLabel', () => {
  it('names a record by its EditorID and FormKey', () => {
    expect(recordLabel('Sword', '000A:Fallout4.esm')).toBe('Sword [000A:Fallout4.esm]');
  });

  it('is the bare FormKey when the record has no EditorID', () => {
    expect(recordLabel(null, '000A:Fallout4.esm')).toBe('000A:Fallout4.esm');
    expect(recordLabel(undefined, '000A:Fallout4.esm')).toBe('000A:Fallout4.esm');
    expect(recordLabel('', '000A:Fallout4.esm')).toBe('000A:Fallout4.esm');
  });
});
