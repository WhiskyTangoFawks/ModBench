import { describe, it, expect } from 'vitest';
import { collapsedReading, versionControlInfo1 } from './presentation';
import { compareOverride, diffNode, fieldMeta } from './test/fixtures';

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

describe('Version Control Info 1 reads as the date, user and index it packs', () => {
  const formVersion = fieldMeta({ name: 'FormVersion', type: 'int' });
  const copy = (version: number | null) => compareOverride({ formKey: '000001:Fallout4.esm', plugin: 'MyMod.esp', fields: [{ metadata: formVersion, value: version }] });

  it.each<[string, number | null, number | null, string]>([
    ['by the older packing before Form Version 44', 33890154, 43, '2005-07-106 User: 5 Index: 2'],
    ['by the bit packing from Form Version 44', 33890154, 44, '2015-11-10 User: 5 Index: 2'],
    ['as None where it packs nothing', null, 131, 'None'],
    ['by the older packing where the copy holds no Form Version', 17001482, null, '2011-12-10 User: 3 Index: 1'],
    ['as the 32 bits of a signed value, as a plugin header holds it', -1, 131, '2127-15-31 User: 255 Index: 255'],
  ])('%s', (_case, stamp, version, reads) => {
    expect(versionControlInfo1(stamp, copy(version))).toBe(reads);
  });
});
