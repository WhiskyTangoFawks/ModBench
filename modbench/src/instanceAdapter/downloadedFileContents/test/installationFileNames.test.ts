import { describe, it, expect } from 'vitest';
import { INSTALLATION_FILE_EXTENSIONS, isInstallationFileName } from '../installationFileNames';

describe('isInstallationFileName', () => {
  it('takes a name ending in an extension install can extract, case-insensitively', () => {
    expect(['a.zip', 'b.7z', 'c.RAR'].map(isInstallationFileName)).toEqual([true, true, true]);
  });

  it('refuses any other name', () => {
    expect(['notes.txt', 'a.zip.meta', 'zip'].map(isInstallationFileName)).toEqual([false, false, false]);
  });
});

describe('INSTALLATION_FILE_EXTENSIONS', () => {
  it('is the installation file extensions install can extract, lower-cased', () => {
    expect([...INSTALLATION_FILE_EXTENSIONS].sort()).toEqual(['7z', 'rar', 'zip']);
  });
});
