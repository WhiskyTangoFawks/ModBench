import { describe, it, expect } from 'vitest';
import { collapsedReading } from './presentation';
import { diffNode, fieldMeta } from './test/fixtures';

const COLUMN = 'MyMod.esp';
const name = fieldMeta({ name: 'Name', type: 'translatedString' });
const several = { TargetLanguage: 'English', Values: [{ Language: 'English', String: 'Old' }, { Language: 'French', String: 'Vieux' }] };
const named = { Name: several, Properties: [] };

describe('a collapsed row reads a translated string in the strings language', () => {
  it.each([
    [
      'a summary', diffNode({ fieldName: 'Script', values: { [COLUMN]: named } }),
      fieldMeta({ name: 'Script', type: 'struct', leafTypeName: 'ScriptEntry', fields: [name] }), 'Vieux()',
    ],
    [
      'a keyed element', diffNode({ fieldName: '[0]', values: { [COLUMN]: { Name: several } } }),
      fieldMeta({ name: '', type: 'struct', fields: [name] }), 'Vieux', ['Name'],
    ],
    [
      'a one-element array', diffNode({ fieldName: 'Names', values: { [COLUMN]: [several] }, children: [
        diffNode({ fieldName: '[0]', values: { [COLUMN]: several }, indexes: { [COLUMN]: 0 } }),
      ] }),
      fieldMeta({ name: 'Names', type: 'array', isArray: true, elementType: name }), 'Vieux',
    ],
  ])('%s', (_case, diff, meta, reads, keyMembers?: string[]) => {
    expect(collapsedReading(diff, meta, COLUMN, 'French', true, keyMembers).text).toBe(reads);
  });
});
