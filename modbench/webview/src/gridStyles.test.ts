import { describe, it, expect } from 'vitest';
import { conflictStateName, getCellStyle, headerBackground, rowBackground } from './gridStyles';
import type { ConflictAll, ConflictThis } from './types';

const colour = (name: string) => `var(--vscode-modbench-${name})`;

describe('the colour a row paints for its conflict', () => {
  it.each<[ConflictAll, string | undefined]>([
    ['Override', colour('conflictRowOverride')],
    ['Conflict', colour('conflictRowConflict')],
    ['ConflictBenign', colour('conflictRowConflict')],
    ['NoConflict', undefined],
    ['OnlyOne', undefined],
  ])('%s paints %s', (state, expected) => {
    expect(rowBackground(state)).toBe(expected);
  });
});

describe('the colour a cell paints for its state', () => {
  it.each<[ConflictThis, object]>([
    ['Override', { backgroundColor: colour('conflictOverride') }],
    ['ConflictWins', { backgroundColor: colour('conflictWins') }],
    ['ConflictLoses', { backgroundColor: colour('conflictLoses'), color: colour('conflictLosesText') }],
    ['IdenticalToMaster', { backgroundColor: colour('conflictIdenticalToMaster') }],
    ['Master', {}],
    ['OnlyOne', {}],
  ])('%s paints %j', (state, expected) => {
    expect(getCellStyle(state)).toEqual(expected);
  });

  it('a header paints its background as its cells do, and none for no state', () => {
    expect([headerBackground('ConflictWins'), headerBackground(null), headerBackground(undefined)])
      .toEqual([colour('conflictWins'), undefined, undefined]);
  });
});

describe('the name a cell state tooltip reads, in xEdit\'s words', () => {
  it.each<[ConflictThis, string]>([
    ['Master', 'Master'],
    ['OnlyOne', 'Single Record'],
    ['IdenticalToMaster', 'Identical to Master'],
    ['Override', 'Override without conflict'],
    ['ConflictWins', 'Conflict winner'],
    ['ConflictLoses', 'Conflict loser'],
  ])('%s reads %s', (state, name) => {
    expect(conflictStateName(state)).toBe(name);
  });
});
