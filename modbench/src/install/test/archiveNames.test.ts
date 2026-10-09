import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { defaultModName, defaultModNameForFolder, isArchiveName } from '../archiveNames';

describe('isArchiveName', () => {
  it('takes a name ending in an extension install can extract, case-insensitively', () => {
    expect(['a.zip', 'b.7z', 'c.RAR'].map(isArchiveName)).toEqual([true, true, true]);
  });

  it('refuses any other name', () => {
    expect(['notes.txt', 'a.zip.meta', 'zip'].map(isArchiveName)).toEqual([false, false, false]);
  });
});

describe('defaultModNameForFolder', () => {
  it("names a new mod after the folder it is installed from", () => {
    expect(defaultModNameForFolder(join('/somewhere', 'Sleep or Save'))).toBe('Sleep or Save');
  });
});

describe('defaultModName', () => {
  it('strips an archive extension install can extract', () => {
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.zip')).toBe('Sleep or Save-123-1-0');
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.7z')).toBe('Sleep or Save-123-1-0');
    expect(defaultModName('/downloads/Sleep or Save-123-1-0.rar')).toBe('Sleep or Save-123-1-0');
  });

  it('strips the extension case-insensitively', () => {
    expect(defaultModName('/downloads/Sleep or Save.ZIP')).toBe('Sleep or Save');
  });

  it('leaves a name with no recognised archive extension untouched', () => {
    expect(defaultModName('/downloads/notes.txt')).toBe('notes.txt');
  });
});
