import { describe, it, expect } from 'vitest';
import { isInstallationFileName } from '../installationFileNames';

describe('an installation file, named for an archive install can extract', () => {
  it.each([
    ['a.zip', true],
    ['b.7z', true],
    ['c.RAR', true],
    ['notes.txt', false],
    ['a.zip.meta', false],
    ['zip', false],
  ])('%s is one: %s', (name, taken) => {
    expect(isInstallationFileName(name)).toBe(taken);
  });
});
