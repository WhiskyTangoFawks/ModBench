import { describe, expect, it } from 'vitest';
import { fieldAt, formKeyAt, formKeyMember, formKeyPluginAt, pluginNameSpans, referenceSpan } from '../pluginSourceText';

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

  it('names the canonical FormKey as the record enclosing a string spelled as Mutagen reads it', () => {
    const spelled = '{ "FormKey": "00080a_A.esp", "Ref": "00080A:B.esp" }';
    expect(fieldAt(spelled, spelled.indexOf('00080A:B') + 1)).toMatchObject({ recordFormKey: '00080A:A.esp' });
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
});

describe('a definition\'s place in its record\'s document (symbols.md, The symbols, Record)', () => {
  const GUN = '000801:A.esp';
  const MEMBER = `"FormKey": "${GUN}"`;

  it.each([
    ['the record\'s own FormKey member', `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`],
    ['a child record\'s FormKey member in its own object, in its owner\'s file', `{ "FormKey": "000700:A.esp", "Temporary": [{ "FormKey": "000802:A.esp" }, { "FormKey": "${GUN}", "EditorID": "Ref" }] }`],
    ['the FormKey member, passing over a field that references the record', `{ "FormKey": "000700:A.esp", "Base": "${GUN}", "Temporary": [{ "FormKey": "${GUN}" }] }`],
  ])('is %s', (_case, document) => {
    const member = formKeyMember(document, GUN);

    expect([member?.start, document.slice(member?.start, member?.end)]).toEqual([document.indexOf(MEMBER), MEMBER]);
  });

  it('is nowhere in a document that states no such member', () => {
    expect(formKeyMember(`{ "Base": "${GUN}" }`, GUN)).toBeUndefined();
  });
});

describe('a plugin\'s name inside a FormKey is the plugin\'s symbol (symbols.md, The symbols, Plugin)', () => {
  const spelled = '{ "FormKey": "000700:A.esp", "Ref": "00080a_B.esp" }';

  it('is found under a place in the name, and not under its object ID', () => {
    const start = spelled.indexOf('B.esp');

    expect(formKeyPluginAt(spelled, start + 5)).toEqual({ name: 'B.esp', start, end: start + 5 });
    expect(formKeyPluginAt(spelled, start - 2)).toBeUndefined();
  });

  it('is spanned in each FormKey of a record that names the plugin, its child records left to themselves', () => {
    const record = `{ "FormKey": "000700:B.esp", "Refs": ["000801:B.esp", "000802:C.esp"], "Placed": [{ "FormKey": "000803:A.esp", "Base": "000804:B.esp" }] }`;

    expect(pluginNameSpans(record, '000700:B.esp', 'B.esp').map(({ start, end }) => record.slice(start, end))).toEqual(['B.esp', 'B.esp']);
  });

  it('is spanned at the record\'s own FormKey when no FormKey of it names the plugin, and at the start without the record', () => {
    expect(pluginNameSpans(spelled, '000700:A.esp', 'Master.esm').map(({ start, end }) => spelled.slice(start, end))).toEqual(['"000700:A.esp"']);
    expect(pluginNameSpans(spelled, '000900:A.esp', 'B.esp')).toEqual([{ start: 0, end: 0 }]);
  });
});
