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
const unresolved: FormKeyResolution = { state: 'Unresolved', recordType: null, editorId: null };

describe('modelValue — scalar types, among the field types whose editor string it alone defines', () => {
  it('string: the string itself', () => {
    expect(modelValue('Dogmeat', strMeta)).toBe('Dogmeat');
  });

  it('int: the number as rendered', () => {
    expect(modelValue(5, intMeta)).toBe('5');
  });

  it('float: the number as rendered', () => {
    expect(modelValue(1.5, floatMeta)).toBe('1.5');
  });

  it('bool: "True"/"False", never a raw boolean', () => {
    expect(modelValue(true, boolMeta)).toBe('True');
    expect(modelValue(false, boolMeta)).toBe('False');
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
  it('the names set, comma-separated, in the document\'s own order', () => {
    expect(modelValue(['C', 'A'], flagMeta)).toBe('C, A');
  });

  it('no names set: empty string, same as absent', () => {
    expect(modelValue([], flagMeta)).toBe('');
    expect(modelValue(null, flagMeta)).toBe('');
  });

  it('a name outside the metadata\'s members reads as itself', () => {
    expect(modelValue(['AB'], flagMeta)).toBe('AB');
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

describe('modelValue — color, by whether its binary form holds an alpha', () => {
  const withAlpha = fieldMeta({ name: 'Color', type: 'color', holdsAlpha: true });
  const withoutAlpha = fieldMeta({ name: 'LightningColor', type: 'color', holdsAlpha: false });

  it('a color holding no alpha reads #RRGGBB, whatever alpha its document carries', () => {
    expect(modelValue('#00102030', withoutAlpha)).toBe('#102030');
    expect(modelValue('#102030', withoutAlpha)).toBe('#102030');
  });

  it('a color holding an alpha reads #AARRGGBB, an opaque one included', () => {
    expect(modelValue('#7F102030', withAlpha)).toBe('#7F102030');
    expect(modelValue('#102030', withAlpha)).toBe('#FF102030');
  });

  it('copies as it reads', () => {
    expect(copiedText('#00102030', withoutAlpha)).toBe('#102030');
  });

  it('text with no color reading reads as itself', () => {
    expect(modelValue('#1020', withAlpha)).toBe('#1020');
  });
});

describe('modelValue — struct/array summary rows (JSON, not a prose summary)', () => {
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

describe('modelValue — a type the wire sends that this union does not name', () => {
  it('stringifies like every other scalar, rather than reading as unset, for a backend field type FieldType has not caught up with', () => {
    const futureMeta: FieldMetadata = { ...fieldMeta({ name: 'Future', type: 'string' }), type: 'quaternion' };
    expect(modelValue(42, futureMeta)).toBe('42');
  });
});

describe('displayValue and copiedText — an enum value the enum does not name', () => {
  it('reads <Unknown: n>', () => {
    expect(displayValue(5, enumMeta)).toBe('<Unknown: 5>');
    expect(displayValue('5', enumMeta)).toBe('<Unknown: 5>');
  });

  it('a named member reads as its name', () => {
    expect(displayValue('Female', enumMeta)).toBe('Female');
  });

  it('copies the value, which the editor can take back', () => {
    expect(copiedText(5, enumMeta)).toBe('5');
    expect(copiedText('Female', enumMeta)).toBe('Female');
  });
});

describe('pastedValue — the text a copy leaves, taken back as the field\'s own value', () => {
  const labelledEnum = fieldMeta({
    name: 'Gender', type: 'enum',
    enumMembers: [{ value: 'Male', label: 'Man' }, { value: 'Female', label: 'Woman' }],
  });

  it.each([
    ['True', true],
    ['False', false],
    [' true ', true],
  ])('bool: %j is %j', (text, expected) => {
    expect(pastedValue(text, boolMeta)).toBe(expected);
  });

  it('bool: text that is neither stays text, for the backend to refuse', () => {
    expect(pastedValue('maybe', boolMeta)).toBe('maybe');
  });

  it('int: a whole number is a number', () => {
    expect(pastedValue('-12', intMeta)).toBe(-12);
  });

  it.each(['12abc', '1.5', ''])('int: %j is not repaired to a number', text => {
    expect(pastedValue(text, intMeta)).toBe(text);
  });

  it('float: a number is a number', () => {
    expect(pastedValue('1.25', floatMeta)).toBe(1.25);
  });

  it.each(['1.25kg', '0x1A', 'Infinity', ''])('float: %j is not repaired to a number', text => {
    expect(pastedValue(text, floatMeta)).toBe(text);
  });

  it('enum: a member\'s label is its value', () => {
    expect(pastedValue('Woman', labelledEnum)).toBe('Female');
  });

  it('enum: a member\'s value is itself', () => {
    expect(pastedValue('Male', labelledEnum)).toBe('Male');
  });

  it('flags: the names joined by a comma are the array of names', () => {
    expect(pastedValue('A, C', flagMeta)).toEqual(['A', 'C']);
  });

  it('flags: no names is no flags set', () => {
    expect(pastedValue('', flagMeta)).toEqual([]);
  });

  it('reference: the FormKey in a label\'s brackets', () => {
    expect(pastedValue('Dogmeat [00001A:Fallout4.esm]', fkMeta)).toBe('00001A:Fallout4.esm');
  });

  it('reference: a bare FormKey is itself', () => {
    expect(pastedValue('00001A:Fallout4.esm', fkMeta)).toBe('00001A:Fallout4.esm');
  });

  it('reference: no text is no reference', () => {
    expect(pastedValue('', fkMeta)).toBeNull();
  });

  it('struct and array: the JSON a copy leaves is the whole value', () => {
    expect(pastedValue('[1,2]', arrayMeta)).toEqual([1, 2]);
    expect(pastedValue('{"Rank":3}', structMeta)).toEqual({ Rank: 3 });
  });

  it('struct: text that is not JSON stays text, for the backend to refuse', () => {
    expect(pastedValue('{oops', structMeta)).toBe('{oops');
  });

  it.each([
    ['text', strMeta, ' Dog '],
    ['bytes', fieldMeta({ name: 'Raw', type: 'hex' }), '0xAB'],
    ['translated text', fieldMeta({ name: 'Name', type: 'translatedString' }), 'New'],
  ])('%s: the text as it is', (_type, meta, text) => {
    expect(pastedValue(text, meta)).toBe(text);
  });
});

describe('shownValue — a value as its cell shows it', () => {
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
