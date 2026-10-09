import { describe, it, expect } from 'vitest';
import { isFieldType } from '../fieldType';

describe('isFieldType', () => {
  it('accepts a type the webview switches on', () => {
    expect(isFieldType('translatedString')).toBe(true);
  });

  it('rejects a type the backend sends that the union does not yet name', () => {
    expect(isFieldType('newKind')).toBe(false);
  });
});
