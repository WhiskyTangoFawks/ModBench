import { describe, expect, it } from 'vitest';
import { fieldAt, formKeyAt, formKeyMember, referenceSpan } from '../sourceText';

const OWNER = '000700:A.esp';
const CHILD = '000802:A.esp';
const text = `{ "FormKey": "${OWNER}", "Race": "Human", "Placed": [{ "FormKey": "${CHILD}", "Base": "Gun" }] }`;

describe('fieldAt', () => {
  it('names the record enclosing the string, with the path from it', () => {
    expect(fieldAt(text, text.indexOf('Human') + 1)).toMatchObject({ recordFormKey: OWNER, path: ['Race'] });
  });

  it('names a child record rather than its owner for a string inside the child', () => {
    const found = fieldAt(text, text.indexOf('Gun') + 1);
    expect(found).toMatchObject({ recordFormKey: CHILD, path: ['Base'], record: { FormKey: CHILD, Base: 'Gun' } });
    expect(text.slice(found?.start, found?.end)).toBe('"Gun"');
  });

  it('finds no field at a member name or outside a record', () => {
    expect(fieldAt(text, text.indexOf('Race') + 1)).toBeUndefined();
    expect(fieldAt('{ "Race": "Human" }', 12)).toBeUndefined();
  });
});

describe('a document spelling a FormKey as Mutagen reads it, not as the Index writes it', () => {
  const spelled = '{ "FormKey": "00080a_A.esp", "Ref": "00080A:B.esp" }';

  it('has its record found by the canonical FormKey', () => {
    expect(formKeyMember(spelled, '00080A:A.esp')).toBeDefined();
    expect(referenceSpan(spelled, '00080A:A.esp', '00080a_B.esp')).not.toEqual({ start: 0, end: 0 });
  });

  it('answers the canonical FormKey at a FormKey string', () => {
    expect(formKeyAt(spelled, spelled.indexOf('00080a_A') + 1)).toMatchObject({ formKey: '00080A:A.esp' });
  });

  it('names the canonical FormKey as the record enclosing a string', () => {
    expect(fieldAt(spelled, spelled.indexOf('00080A:B') + 1)).toMatchObject({ recordFormKey: '00080A:A.esp' });
  });
});
