import { describe, it, expect } from 'vitest';
import { ARCHIVE_EXTENSIONS, isArchiveName } from '../archiveNames';

describe('isArchiveName', () => {
  it('takes a name ending in an extension install can extract, case-insensitively', () => {
    expect(['a.zip', 'b.7z', 'c.RAR'].map(isArchiveName)).toEqual([true, true, true]);
  });

  it('refuses any other name', () => {
    expect(['notes.txt', 'a.zip.meta', 'zip'].map(isArchiveName)).toEqual([false, false, false]);
  });
});

describe('ARCHIVE_EXTENSIONS', () => {
  it('is the archive extensions install can extract, lower-cased', () => {
    expect([...ARCHIVE_EXTENSIONS].sort()).toEqual(['7z', 'rar', 'zip']);
  });
});
