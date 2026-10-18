import { describe, it, expect } from 'vitest';
import { decompileAndCommitProgressMessage } from '../decompileAndCommitProgress';

describe('decompileAndCommitProgressMessage', () => {
  it.each([
    ['Parsing', 'parsing'],
    ['Serializing', 'serializing'],
    ['ReadingFiles', 'reading its files'],
    ['Committing', 'committing'],
  ] as const)('names the %s phase', (phase, words) => {
    expect(decompileAndCommitProgressMessage('ModA', phase)).toContain(words);
  });

  it('names the mod in every phase, and when it has none', () => {
    for (const phase of ['Parsing', 'Serializing', 'ReadingFiles', 'Committing', undefined] as const) {
      expect(decompileAndCommitProgressMessage('MyMod', phase)).toContain('MyMod');
    }
  });
});
