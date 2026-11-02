import { describe, it, expect } from 'vitest';
import { versionInGitProgressMessage } from '../versionInGitProgress';

describe('the version in git phase line', () => {
  it.each([
    ['Parsing', 'Version in git "MyMod" — parsing…'],
    ['Serializing', 'Version in git "MyMod" — serializing…'],
    ['ReadingFiles', 'Version in git "MyMod" — reading its files…'],
    ['Committing', 'Version in git "MyMod" — writing the repository…'],
    [undefined, 'Version in git "MyMod"…'],
    [null, 'Version in git "MyMod"…'],
  ] as const)('says %s as %s', (phase, message) => {
    expect(versionInGitProgressMessage('MyMod', phase)).toBe(message);
  });
});
