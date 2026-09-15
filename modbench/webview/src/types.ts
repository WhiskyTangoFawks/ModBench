import type { components } from '../../src/medit/generated/api';

type Schemas = components['schemas'];

// The record editor's wire DTOs: every type here is the generated schema type. Narrowing a wire
// `string` to the closed set this side switches on exhaustively stays; re-declaring a field the
// schema already describes does not.

export type FormKeyResolutionState = Schemas['FormKeyResolutionState'];
export type FormKeyResolution = Schemas['FormKeyResolution'];
export type ConflictAll = Schemas['ConflictAll'];
export type ConflictThis = Schemas['ConflictThis'];
export type EnumMember = Schemas['EnumMember'];
/** The closed set this side switches on. Each names the codec's spelling: a translated string is
 *  an object, a color "#AARRGGBB", a vector "x, y, z", flags an array of names. */
export type FieldType =
  | 'string' | 'translatedString' | 'int' | 'float' | 'bool' | 'enum' | 'flags' | 'formKey'
  | 'struct' | 'array' | 'hex' | 'color' | 'vector';

const FIELD_TYPES: readonly FieldType[] = [
  'string', 'translatedString', 'int', 'float', 'bool', 'enum', 'flags', 'formKey',
  'struct', 'array', 'hex', 'color', 'vector',
];

// Narrows FieldMetadata's plain wire string into FieldType, for a switch that needs the union.
export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

/** `readOnly` is the one member the wire does not carry: a per-row stamp regardless of the
 *  column's own mutability — "per column, never a mode". */
export type FieldMetadata =
  Omit<Schemas['FieldMetadata'], 'type' | 'elementType' | 'fields' | 'variants'> & {
    // The wire's field type is a string, and the backend may send one this union does not yet name.
    type: string;
    elementType?: FieldMetadata | null;   // present when type === 'array'
    fields?: FieldMetadata[] | null;      // present when type === 'struct'
    variants?: Record<string, FieldMetadata> | null;
    readOnly?: boolean;
  };

export type FieldValue = Omit<Schemas['FieldValue'], 'metadata'> & { metadata: FieldMetadata };

// ADR-0012: a column is (plugin, origin), not plugin alone — two columns can share a filename.
// The brand makes comparing one against a bare plugin string a compile error; a mapped type
// erases it. Minted only by columnKey() (./columnKey.ts).
export type ColumnKey = string & { readonly __col: unique symbol };

export type RecordDetail = Omit<Schemas['RecordDetail'], 'fields'> & { fields: FieldValue[] };

export type CompareOverride = Omit<Schemas['CompareOverride'], 'fields'> & { fields: FieldValue[] };

// Lives in messages.ts so it can cross to the extension host.
export type { PathHop, PathSegment, RecordEditEnvelope } from './messages';

export type FieldDiff = Omit<Schemas['FieldDiff'], 'children'> & {
  children?: FieldDiff[] | null;
};

export type CompareResult = Omit<Schemas['CompareResult'], 'overrides' | 'diffs'> & {
  overrides: CompareOverride[];
  diffs: FieldDiff[];
};
