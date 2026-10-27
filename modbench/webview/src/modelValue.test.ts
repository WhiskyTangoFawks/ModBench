import { describe, it, expect } from 'vitest';
import { copiedText, displayValue, modelValue, pastedValue, shownValue } from './modelValue';
import type { FieldMetadata, FormKeyResolution } from './types';
import { fieldMeta } from './test/fixtures';

const strMeta = fieldMeta({ name: 'Name', type: 'string' });
const intMeta = fieldMeta({ name: 'Level', type: 'int' });
const floatMeta = fieldMeta({ name: 'Weight', type: 'float' });
const boolMeta = fieldMeta({ name: 'Female', type: 'bool' });
const enumMeta = fieldMeta({
  name: 'Gender', type: 'enum',
  enumMembers: [{ value: 'Male' }, { value: 'Female' }, { value: 'None' }],
});
const flagMeta = fieldMeta({
  name: 'Flags', type: 'flags',
  enumMembers: [{ value: 'A', bitValue: '1' }, { value: 'B', bitValue: '2' },
    { value: 'C', bitValue: '4' }, { value: 'D', bitValue: '8' }],
});
const fkMeta = fieldMeta({ name: 'Owner', type: 'formKey', validFormKeyTypes: ['NPC_'] });
const structMeta = fieldMeta({
  name: 'Faction', type: 'struct',
  fields: [
    fieldMeta({ name: 'Faction', type: 'formKey', validFormKeyTypes: ['FACT'] }),
    fieldMeta({ name: 'Rank', type: 'int' }),
  ],
});
const arrayMeta = fieldMeta({
  name: 'Factions', type: 'array', isArray: true,
  elementType: fieldMeta({ name: 'Factions', type: 'int' }),
});

const resolved: FormKeyResolution = { state: 'ResolvedValidType', recordType: 'NPC_', editorId: 'Dogmeat' };

const withAlpha = fieldMeta({ name: 'Color', type: 'color', holdsAlpha: true });
const withoutAlpha = fieldMeta({ name: 'LightningColor', type: 'color', holdsAlpha: false });
const futureMeta: FieldMetadata = { ...fieldMeta({ name: 'Future', type: 'string' }), type: 'quaternion' };

describe('a value\'s edit text, which its readout and Ctrl+C share with the editor', () => {
  it.each([
    ['a string is itself', 'Dogmeat', strMeta, 'Dogmeat'],
    ['an int is the number as rendered', 5, intMeta, '5'],
    ['a float is the number as rendered', 1.5, floatMeta, '1.5'],
    ['a six-digit float is not read as a colour', 123456, floatMeta, '123456'],
    ['a string that looks like a colour is as typed', '#FF8000', strMeta, '#FF8000'],
    ['a lower-case hex string is as typed', 'ff8000', strMeta, 'ff8000'],
    ['a bool true is "True", never a raw boolean', true, boolMeta, 'True'],
    ['a bool false is "False"', false, boolMeta, 'False'],
    ['an enum is its name, never an integer index', 'Female', enumMeta, 'Female'],
    ['a null string is empty', null, strMeta, ''],
    ['an undefined int is empty', undefined, intMeta, ''],
    ['a null bool is empty', null, boolMeta, ''],
    ['a null enum is empty', null, enumMeta, ''],
    ['flags are the names set, comma-separated, in the document\'s own order', ['C', 'A'], flagMeta, 'C, A'],
    ['no flags set is empty', [], flagMeta, ''],
    ['absent flags are empty', null, flagMeta, ''],
    ['a flag name outside the metadata\'s members reads as itself', ['AB'], flagMeta, 'AB'],
    ['a null reference is empty, not a placeholder glyph', null, fkMeta, ''],
    ['an empty reference is empty', '', fkMeta, ''],
    ['a color holding no alpha reads #RRGGBB, whatever alpha its document carries', '#00102030', withoutAlpha, '#102030'],
    ['a color holding no alpha reads an opaque one as #RRGGBB', '#102030', withoutAlpha, '#102030'],
    ['a color holding an alpha reads #AARRGGBB', '#7F102030', withAlpha, '#7F102030'],
    ['a color holding an alpha reads an opaque one with its alpha', '#102030', withAlpha, '#FF102030'],
    ['text with no color reading reads as itself', '#1020', withAlpha, '#1020'],
    ['a struct is the JSON of the whole value, not the "{…}" placeholder', { Faction: '000123:Fallout4.esm', Rank: 2 }, structMeta, '{"Faction":"000123:Fallout4.esm","Rank":2}'],
    ['an array is the JSON of the whole value, not the "[n]" placeholder', [1, 2, 3], arrayMeta, '[1,2,3]'],
    ['a null struct is empty, not "null"', null, structMeta, ''],
    ['a null array is empty, not "null"', null, arrayMeta, ''],
    ['a type the wire sends that this union does not name stringifies, rather than reading as unset', 42, futureMeta, '42'],
  ])('%s', (_case, value, meta, text) => {
    expect(modelValue(value, meta)).toBe(text);
  });

  it('a resolved reference is the label its link shows', () => {
    expect(modelValue('000001:Fallout4.esm', fkMeta, resolved)).toBe('Dogmeat [000001:Fallout4.esm]');
  });
});

const recordFlagsMeta = fieldMeta({
  name: 'MajorRecordFlagsRaw', type: 'int',
  enumMembers: [{ value: 'Deleted', bitValue: '32' }, { value: 'Persistent', bitValue: '1024' }],
});

describe('an integer whose bits the schema names reads, copies and pastes as flags', () => {
  it('reads the names of the bits set, then each unnamed bit in hex', () => {
    expect(modelValue(1024 | 32 | 0x4000, recordFlagsMeta)).toBe('Deleted, Persistent, 0x4000');
    expect(copiedText(1024, recordFlagsMeta)).toBe('Persistent');
  });

  it('reads no bits set as no names', () => {
    expect(modelValue(0, recordFlagsMeta)).toBe('');
  });

  it('pastes the names and hex bits a copy leaves as the integer', () => {
    expect(pastedValue('Deleted, Persistent, 0x4000', recordFlagsMeta)).toBe(1024 | 32 | 0x4000);
    expect(pastedValue('', recordFlagsMeta)).toBe(0);
  });

  it('pastes a name the schema does not list as the text, for mEdit to refuse', () => {
    expect(pastedValue('Persistent, Bogus', recordFlagsMeta)).toBe('Persistent, Bogus');
  });
});

describe('a value as its cell reads it and Ctrl+C copies it', () => {
  it.each([
    ['an enum value the enum does not name reads <Unknown: n>', 5, enumMeta, '<Unknown: 5>', '5'],
    ['an unnamed enum value given as text reads <Unknown: n>', '5', enumMeta, '<Unknown: 5>', '5'],
    ['a named enum member reads and copies as its name', 'Female', enumMeta, 'Female', 'Female'],
    ['a color copies as it reads', '#00102030', withoutAlpha, '#102030', '#102030'],
  ])('%s', (_case, value, meta, shown, copied) => {
    expect([displayValue(value, meta), copiedText(value, meta)]).toEqual([shown, copied]);
  });
});

describe('the text a copy leaves, taken back as the field\'s own value', () => {
  const labelledEnum = fieldMeta({
    name: 'Gender', type: 'enum',
    enumMembers: [{ value: 'Male', label: 'Man' }, { value: 'Female', label: 'Woman' }],
  });

  it.each([
    ['bool: "True" is true', 'True', boolMeta, true],
    ['bool: "False" is false', 'False', boolMeta, false],
    ['bool: case and space do not matter', ' true ', boolMeta, true],
    ['bool: text that is neither stays text, for the backend to refuse', 'maybe', boolMeta, 'maybe'],
    ['int: a whole number is a number', '-12', intMeta, -12],
    ['int: trailing text is not repaired to a number', '12abc', intMeta, '12abc'],
    ['int: a fraction is not repaired to a whole number', '1.5', intMeta, '1.5'],
    ['int: no text is not a number', '', intMeta, ''],
    ['float: a number is a number', '1.25', floatMeta, 1.25],
    ['float: a unit is not repaired away', '1.25kg', floatMeta, '1.25kg'],
    ['float: hex is not a float', '0x1A', floatMeta, '0x1A'],
    ['float: Infinity is not a float', 'Infinity', floatMeta, 'Infinity'],
    ['float: no text is not a number', '', floatMeta, ''],
    ['enum: a member\'s label is its value', 'Woman', labelledEnum, 'Female'],
    ['enum: a member\'s value is itself', 'Male', labelledEnum, 'Male'],
    ['flags: the names joined by a comma are the array of names', 'A, C', flagMeta, ['A', 'C']],
    ['flags: no names is no flags set', '', flagMeta, []],
    ['reference: the FormKey in a label\'s brackets', 'Dogmeat [00001A:Fallout4.esm]', fkMeta, '00001A:Fallout4.esm'],
    ['reference: a bare FormKey is itself', '00001A:Fallout4.esm', fkMeta, '00001A:Fallout4.esm'],
    ['reference: no text is no reference', '', fkMeta, null],
    ['array: the JSON a copy leaves is the whole value', '[1,2]', arrayMeta, [1, 2]],
    ['struct: the JSON a copy leaves is the whole value', '{"Rank":3}', structMeta, { Rank: 3 }],
    ['struct: text that is not JSON stays text, for the backend to refuse', '{oops', structMeta, '{oops'],
    ['text: the text as it is', ' Dog ', strMeta, ' Dog '],
    ['bytes: the text as it is', '0xAB', fieldMeta({ name: 'Raw', type: 'hex' }), '0xAB'],
    ['translated text: the text as it is', 'New', fieldMeta({ name: 'Name', type: 'translatedString' }), 'New'],
  ])('%s', (_case, text, meta, value) => {
    expect(pastedValue(text, meta)).toEqual(value);
  });
});

describe('a value as its cell shows it', () => {
  const name = fieldMeta({ name: 'Name', type: 'translatedString' });
  const several = (other: string) => ({
    TargetLanguage: 'English', Values: [{ Language: 'English', String: 'Old' }, { Language: other, String: 'Vieux' }],
  });

  it.each([
    ['a translated string: its one text', name, { TargetLanguage: 'English', Value: 'Old' }, 'Old'],
    ['a translated string: its text in the strings language', name, several('French'), 'Vieux'],
    ['a translated string: nothing where it holds no text in the strings language', name, several('German'), ''],
    ['any other value: itself', intMeta, 5, 5],
  ])('%s', (_case, meta, value, shown) => {
    expect(shownValue(value, meta, 'French')).toEqual(shown);
  });
});
