import { describe, it, expect } from 'vitest';
import { modelValue, toBigInt } from './modelValue';
import type { FieldMetadata, FormKeyResolution } from './types';

// ADR-0034: modelValue is the single definition of "the string a cell's editor
// shows" for every field type (xEdit's Element.EditValue) — DiffRow's Ctrl+C copy reads straight
// off it, and ScalarCell/FlagCell source their own display/draft text from it too (see their own
// test files), so this suite is the independent source of truth for what each type's string
// looks like, checked independently of the leaf components' own logic.

const strMeta: FieldMetadata = { name: 'Name', type: 'string', isArray: false, validFormKeyTypes: [], enumMembers: [] };
const intMeta: FieldMetadata = { name: 'Level', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] };
const floatMeta: FieldMetadata = { name: 'Weight', type: 'float', isArray: false, validFormKeyTypes: [], enumMembers: [] };
const boolMeta: FieldMetadata = { name: 'Female', type: 'bool', isArray: false, validFormKeyTypes: [], enumMembers: [] };
const enumMeta: FieldMetadata = {
  name: 'Gender', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumMembers: [{ value: 'Male' }, { value: 'Female' }, { value: 'None' }],
};
const flagMeta: FieldMetadata = {
  name: 'Flags', type: 'enum', isArray: false, validFormKeyTypes: [],
  enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' },
    { value: 'C', bitValue: '4' }, { value: 'D', bitValue: '8' }],
};
const fkMeta: FieldMetadata = { name: 'Owner', type: 'formKey', isArray: false, validFormKeyTypes: ['NPC_'], enumMembers: [] };
const structMeta: FieldMetadata = {
  name: 'Faction', type: 'struct', isArray: false, validFormKeyTypes: [], enumMembers: [],
  fields: [
    { name: 'Faction', type: 'formKey', isArray: false, validFormKeyTypes: ['FACT'], enumMembers: [] },
    { name: 'Rank', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
  ],
};
const arrayMeta: FieldMetadata = {
  name: 'Factions', type: 'array', isArray: true, validFormKeyTypes: [], enumMembers: [],
  elementType: { name: 'Factions', type: 'int', isArray: false, validFormKeyTypes: [], enumMembers: [] },
};

const resolved: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'NPC_', editorId: 'Dogmeat' };
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

describe('modelValue — scalar types', () => {
  it('string: the string itself', () => {
    expect(modelValue('Dogmeat', strMeta)).toBe('Dogmeat');
  });

  it('int: the number as rendered', () => {
    expect(modelValue(5, intMeta)).toBe('5');
  });

  it('float: the number as rendered', () => {
    expect(modelValue(1.5, floatMeta)).toBe('1.5');
  });

  it('bool: "true"/"false", never a raw boolean', () => {
    expect(modelValue(true, boolMeta)).toBe('true');
    expect(modelValue(false, boolMeta)).toBe('false');
  });

  it('enum: the enum name, never an integer index', () => {
    expect(modelValue('Female', enumMeta)).toBe('Female');
  });

  it('null/undefined: empty string for every scalar type', () => {
    expect(modelValue(null, strMeta)).toBe('');
    expect(modelValue(undefined, intMeta)).toBe('');
    expect(modelValue(null, boolMeta)).toBe('');
    expect(modelValue(null, enumMeta)).toBe('');
  });
});

describe('modelValue — flags', () => {
  it('active flag names, comma-separated — never the bitmask integer', () => {
    expect(modelValue(0b0101, flagMeta)).toBe('A, C');
  });

  it('no active bits: empty string, same as null', () => {
    expect(modelValue(0, flagMeta)).toBe('');
    expect(modelValue(null, flagMeta)).toBe('');
  });

  it('a decimal-string bitmask above 2^53 resolves with BigInt precision', () => {
    const highBit: FieldMetadata = {
      name: 'RaceFlags', type: 'enum', isArray: false, validFormKeyTypes: [],
      enumMembers: [{ value: 'Playable', bitValue: '1' },
        { value: 'LowPriorityPushable', bitValue: '9007199254740992' }],
    };
    expect(modelValue('9007199254740993', highBit)).toBe('Playable, LowPriorityPushable');
  });

  it('a bitless member falls back to toStr rather than throwing', () => {
    const broken: FieldMetadata = { name: 'X', type: 'enum', isArray: false, validFormKeyTypes: [], enumMembers: [{ value: 'A' }] };
    expect(() => modelValue(3, broken)).not.toThrow();
  });

  // "every member carries a bit" is vacuously true of no members at all, so an enum with an empty
  // domain would render as a (permanently empty) flag list where a plain value belongs.
  it('an enum with no members at all is not a flag list', () => {
    const empty: FieldMetadata = { name: 'X', type: 'enum', isArray: false, validFormKeyTypes: [], enumMembers: [] };
    expect(modelValue('Whatever', empty)).toBe('Whatever');
  });

  it('a partly-bitless member list is not a flag list', () => {
    const mixed: FieldMetadata = {
      name: 'X', type: 'enum', isArray: false, validFormKeyTypes: [],
      enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B' }],
    };
    expect(modelValue('3', mixed)).toBe('3');
  });
});

describe('modelValue — formKey', () => {
  it('resolved: the EditorID [FormKey] composite — the same label FormKeyLink/the picker use', () => {
    expect(modelValue('000001:Fallout4.esm', fkMeta, resolved)).toBe('Dogmeat [000001:Fallout4.esm]');
  });

  it('unresolved: the bare FormKey', () => {
    expect(modelValue('000001:Fallout4.esm', fkMeta, unresolved)).toBe('000001:Fallout4.esm');
  });

  it('no resolution supplied: the bare FormKey (same default FormKeyLink/FormKeyCell use)', () => {
    expect(modelValue('000001:Fallout4.esm', fkMeta)).toBe('000001:Fallout4.esm');
  });

  it('null/empty reference: empty string, not a placeholder glyph', () => {
    expect(modelValue(null, fkMeta)).toBe('');
    expect(modelValue('', fkMeta)).toBe('');
  });
});

describe('modelValue — struct/array summary rows (#224 decision: JSON, not a prose summary)', () => {
  it('struct: JSON-serializes the whole value, not the "{…}" placeholder', () => {
    const value = { Faction: '000123:Fallout4.esm', Rank: 2 };
    expect(modelValue(value, structMeta)).toBe(JSON.stringify(value));
    expect(modelValue(value, structMeta)).not.toBe('{…}');
  });

  it('array: JSON-serializes the whole value, not the "[n]" placeholder', () => {
    const value = [1, 2, 3];
    expect(modelValue(value, arrayMeta)).toBe(JSON.stringify(value));
    expect(modelValue(value, arrayMeta)).not.toBe('[3]');
  });

  it('a struct/array round-trips through JSON.parse back to an equal value', () => {
    const structValue = { Faction: '000123:Fallout4.esm', Rank: 2 };
    expect(JSON.parse(modelValue(structValue, structMeta))).toEqual(structValue);
    const arrayValue = [1, 2, 3];
    expect(JSON.parse(modelValue(arrayValue, arrayMeta))).toEqual(arrayValue);
  });

  it('null struct/array: empty string, not "null"', () => {
    expect(modelValue(null, structMeta)).toBe('');
    expect(modelValue(null, arrayMeta)).toBe('');
  });
});

describe('toBigInt (shared with FlagCell)', () => {
  it('parses a decimal string', () => {
    expect(toBigInt('12')).toBe(12n);
  });

  it('parses a small number', () => {
    expect(toBigInt(12)).toBe(12n);
  });

  it('falls back to 0n on malformed input', () => {
    expect(toBigInt('abc')).toBe(0n);
    expect(toBigInt({})).toBe(0n);
  });
});
