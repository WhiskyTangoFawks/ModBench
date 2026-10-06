import { describe, it, expect } from 'vitest';
import { formKeyMember } from '../formKeyDefinition';

const GUN = '000801:A.esp';

const spanned = (text: string, formKey: string): string | undefined => {
  const member = formKeyMember(text, formKey);
  return member && text.slice(member.start, member.end);
};

describe('a definition\'s place in its record\'s document (plugin-source.md, In the text editor, story 1)', () => {
  it('is the record\'s own FormKey member', () => {
    const text = `{\n  "FormKey": "${GUN}",\n  "EditorID": "Gun"\n}`;

    expect(spanned(text, GUN)).toBe(`"FormKey": "${GUN}"`);
  });

  it('is a child record\'s FormKey member in its own object, in its owner\'s file', () => {
    const text = `{ "FormKey": "000700:A.esp", "Temporary": [{ "FormKey": "000802:A.esp" }, { "FormKey": "${GUN}", "EditorID": "Ref" }] }`;

    expect(formKeyMember(text, GUN)?.start).toBe(text.indexOf(`"FormKey": "${GUN}"`));
  });

  it('passes over a field that references the record', () => {
    const text = `{ "FormKey": "000700:A.esp", "Base": "${GUN}", "Temporary": [{ "FormKey": "${GUN}" }] }`;

    expect(formKeyMember(text, GUN)?.start).toBe(text.indexOf(`"FormKey": "${GUN}"`));
  });

  it('is nowhere in a document that states no such member', () => {
    expect(formKeyMember(`{ "Base": "${GUN}" }`, GUN)).toBeUndefined();
  });
});
