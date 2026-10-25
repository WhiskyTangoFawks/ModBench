import { describe, it, expect } from 'vitest';
import { decompileAndCommitProgressMessage } from '../decompileAndCommitProgress';

describe('the decompile and commit phase line', () => {
  it.each([
    ['Parsing', 'Decompiling and committing "MyMod" — parsing…'],
    ['Serializing', 'Decompiling and committing "MyMod" — serializing…'],
    ['ReadingFiles', 'Decompiling and committing "MyMod" — reading its files…'],
    ['Committing', 'Decompiling and committing "MyMod" — committing to git…'],
    [undefined, 'Decompiling and committing "MyMod"…'],
    [null, 'Decompiling and committing "MyMod"…'],
  ] as const)('says %s as %s', (phase, message) => {
    expect(decompileAndCommitProgressMessage('MyMod', phase)).toBe(message);
  });
});
