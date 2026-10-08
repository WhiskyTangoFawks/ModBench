import { describe, expect, it } from 'vitest';
import { fieldAt } from '../sourceText';

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
