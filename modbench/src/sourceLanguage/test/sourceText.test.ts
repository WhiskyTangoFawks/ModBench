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

  const spanned = (span: { start: number; end: number } | undefined) => spelled.slice(span?.start, span?.end);

  it('has its record\'s FormKey member found by the canonical FormKey', () => {
    expect(spanned(formKeyMember(spelled, '00080A:A.esp'))).toBe('"FormKey": "00080a_A.esp"');
  });

  it('has a reference found by the canonical FormKeys of its record and its target', () => {
    expect(spanned(referenceSpan(spelled, '00080A:A.esp', '00080a_B.esp'))).toBe('"00080A:B.esp"');
  });

  it('answers the canonical FormKey at a FormKey string', () => {
    expect(formKeyAt(spelled, spelled.indexOf('00080a_A') + 1)).toMatchObject({ formKey: '00080A:A.esp' });
  });

  it('takes an EditorID that merely looks like a FormKey for none', () => {
    const editorId = '{ "FormKey": "000800:A.esp", "EditorID": "ABCDEF_Foo" }';
    expect(formKeyAt(editorId, editorId.indexOf('ABCDEF_Foo') + 1)).toBeUndefined();
  });

  it('names the canonical FormKey as the record enclosing a string', () => {
    expect(fieldAt(spelled, spelled.indexOf('00080A:B') + 1)).toMatchObject({ recordFormKey: '00080A:A.esp' });
  });
});
