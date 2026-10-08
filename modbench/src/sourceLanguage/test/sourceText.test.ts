import { parseTree, type Node } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { findStringValue, formKeyAt, formKeyMember, recordObject, stringAt } from '../sourceText';

const GUN = '000800:A.esp';

function parsed(text: string): Node {
  const root = parseTree(text);
  if (!root) throw new Error('unparsable');
  return root;
}

describe('sourceText', () => {
  it('reads the FormKey string under an offset', () => {
    const text = `{ "Armor": "${GUN}" }`;
    const start = text.indexOf(GUN) - 1;
    expect(formKeyAt(text, start + 2)).toEqual({ formKey: GUN, start, end: start + GUN.length + 2 });
  });

  it('reads no FormKey from a member name or a string that is not one', () => {
    const text = `{ "${GUN}": "Gun" }`;
    expect(formKeyAt(text, 5)).toBeUndefined();
    expect(formKeyAt(text, text.indexOf('Gun'))).toBeUndefined();
  });

  it('finds the string value under an offset, never a member name', () => {
    const text = '{ "Name": "Gun" }';
    expect(stringAt(text, text.indexOf('Name'))).toBeUndefined();
    expect(stringAt(text, text.indexOf('Gun'))?.value).toBe('Gun');
  });

  it('finds a record by its own FormKey, nested or not', () => {
    const text = `{ "FormKey": "000700:A.esp", "Placed": [{ "FormKey": "${GUN}" }] }`;
    const root = parsed(text);
    expect(recordObject(root, GUN)?.offset).toBe(text.indexOf(`{ "FormKey": "${GUN}"`));
    expect(recordObject(root, '000999:A.esp')).toBeUndefined();
  });

  it('spans the FormKey member of the record', () => {
    const text = `{ "Armor": "${GUN}", "FormKey": "${GUN}" }`;
    expect(formKeyMember(text, GUN)?.start).toBe(text.indexOf('"FormKey"'));
  });

  it('finds the first string value, never a member name', () => {
    const text = `{ "${GUN}": 1, "Armor": "${GUN}" }`;
    expect(findStringValue(parsed(text), GUN)?.offset).toBe(text.lastIndexOf(`"${GUN}"`));
  });
});
