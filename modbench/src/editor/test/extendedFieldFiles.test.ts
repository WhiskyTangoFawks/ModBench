import { describe, it, expect } from 'vitest';
import { basename, join } from 'node:path';
import { extendedFieldFile } from '../extendedFieldFiles';

const DEACON = { recordLabel: 'Deacon [000123:Fallout4.esm]', fieldName: 'Description', plugin: 'Fallout4.esm', origin: 'Data' };

describe('extendedFieldFile', () => {
  it('sanitizes the FormKey\'s Windows-reserved colon, keeps the brackets (valid in a filename on any filesystem), and composes dir/origin/file from record, field, plugin', () => {
    expect(extendedFieldFile('/tmp/root', DEACON)).toEqual({
      folder: join('/tmp/root', 'Deacon [000123_Fallout4.esm]', 'Data'),
      file: join('/tmp/root', 'Deacon [000123_Fallout4.esm]', 'Data', 'Description [Fallout4.esm]'),
    });
  });

  it('names the file exactly as the tab is titled, <field> [<file name>]', () => {
    expect(basename(extendedFieldFile('/tmp/root', DEACON).file)).toBe('Description [Fallout4.esm]');
  });

  it('is deterministic — the same identity always produces the same file', () => {
    expect(extendedFieldFile('/tmp/root', DEACON)).toEqual(extendedFieldFile('/tmp/root', { ...DEACON }));
  });

  it('folds a non-Data origin into its own directory segment, between the record and the field', () => {
    const { file } = extendedFieldFile('/tmp/root', { recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp', origin: 'ModA' });
    expect(file).toBe(join('/tmp/root', 'Deacon', 'ModA', 'Description [Shared.esp]'));
  });

  it('two columns sharing a filename but differing in origin never collide', () => {
    const column = { recordLabel: 'Deacon', fieldName: 'Description', plugin: 'Shared.esp' };
    expect(extendedFieldFile('/tmp/root', { ...column, origin: 'ModA' }).file)
      .not.toBe(extendedFieldFile('/tmp/root', { ...column, origin: 'ModB' }).file);
  });

  it('strips path separators from a hostile origin read off disk, so it cannot escape the temp root', () => {
    const { file } = extendedFieldFile('/tmp/root', { ...DEACON, recordLabel: 'Deacon', origin: '../../../etc/passwd' });
    expect(file).toBe(join('/tmp/root', 'Deacon', '.._.._.._etc_passwd', 'Description [Fallout4.esm]'));
  });
});
