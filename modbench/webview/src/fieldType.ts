/** The closed set the webview switches on. Each names the codec's spelling: a translated string is
 *  an object, a color "#AARRGGBB" or "#RRGGBB" when opaque, a vector "x, y, z", flags an array of names. */
export type FieldType =
  | 'string' | 'translatedString' | 'int' | 'float' | 'bool' | 'enum' | 'flags' | 'formKey'
  | 'struct' | 'array' | 'hex' | 'color' | 'vector';

const FIELD_TYPES: readonly FieldType[] = [
  'string', 'translatedString', 'int', 'float', 'bool', 'enum', 'flags', 'formKey',
  'struct', 'array', 'hex', 'color', 'vector',
];

/** Narrows the wire's plain `FieldMetadata.type` string: the backend may send one the union does not yet name. */
export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}
