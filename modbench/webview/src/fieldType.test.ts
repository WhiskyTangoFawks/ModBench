import { describe, it, expect } from 'vitest';
import { isFieldType } from './fieldType';

describe('a field type the webview switches on', () => {
  it.each([
    ['a type the union names is one', 'translatedString', true],
    ['a type the backend sends that the union does not yet name is not', 'newKind', false],
  ])('%s', (_case, type, known) => {
    expect(isFieldType(type)).toBe(known);
  });
});
