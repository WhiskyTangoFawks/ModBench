import { describe, it, expect } from 'vitest';
import { recordLabel } from '../recordLabel';

describe('recordLabel', () => {
  it('names a record by its EditorID and FormKey', () => {
    expect(recordLabel('Sword', '000A:Fallout4.esm')).toBe('Sword [000A:Fallout4.esm]');
  });

  it.each([null, undefined, ''])('is the bare FormKey when the EditorID is %j', (editorId) => {
    expect(recordLabel(editorId, '000A:Fallout4.esm')).toBe('000A:Fallout4.esm');
  });
});
