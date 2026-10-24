import { describe, it, expect } from 'vitest';
import { originsOfLinesNotRestored } from '../pluginsNotRestored';

describe('the origin of a line with no file that a manifest names', () => {
  it.each<[string, Record<string, readonly string[]>, readonly string[], [string, string][]]>([
    ['is the mod whose manifest names it', { 'Mod B': [], 'Mod C': ['AccC.esp'] }, ['AccC.esp'], [['accc.esp', 'Mod C']]],
    ['is the first in mod order when two manifests name it, whatever the case', { 'Mod B': ['accc.esp'], 'Mod C': ['AccC.esp'] }, ['AccC.esp'], [['accc.esp', 'Mod B']]],
    ['is none for a line whose file is on disk', { 'Mod B': [], 'Mod C': ['AccC.esp'] }, [], []],
    ['is none for a file the manifest names below the folder\'s root', { 'Mod B': [], 'Mod C': ['optional/AccC.esp'] }, ['AccC.esp'], []],
  ])('%s', (_case, gone, linesWithoutFile, origins) => {
    expect([...originsOfLinesNotRestored(['Mod B', 'Mod C'], linesWithoutFile, (mod) => gone[mod] ?? [])]).toEqual(origins);
  });
});
