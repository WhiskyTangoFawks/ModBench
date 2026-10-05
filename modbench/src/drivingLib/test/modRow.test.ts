import { describe, it, expect } from 'vitest';
import { modOfRow } from '../modRow';

describe('the mod a row stands for', () => {
  it('is the name of a row that holds a mod, whatever box built the row', () => {
    expect(modOfRow({ kind: 'mod', mod: { name: 'Patch' } })).toBe('Patch');
  });

  it('is none for a separator, the Overwrite row, a plugin row or anything else', () => {
    expect(modOfRow({ kind: 'separator', separator: { name: 'Patch' } })).toBeUndefined();
    expect(modOfRow({ kind: 'overwrite' })).toBeUndefined();
    expect(modOfRow({ name: 'Patch', origin: 'Patch' })).toBeUndefined();
    expect(modOfRow({ kind: 'mod' })).toBeUndefined();
    expect(modOfRow({ kind: 'mod', mod: {} })).toBeUndefined();
    expect(modOfRow(undefined)).toBeUndefined();
  });
});
