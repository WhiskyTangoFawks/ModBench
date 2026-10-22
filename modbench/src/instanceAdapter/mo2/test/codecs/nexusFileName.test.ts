import { describe, it, expect } from 'vitest';
import { effectiveModId } from '../../codecs/nexusFileName';

describe('the Nexus mod ID an install gives a mod', () => {
  it.each([
    ['Harder VATS-1234-1-0-1700000000.7z', '1234'],
    ['Harder VATS-1234-1-0.zip', '1234'],
    ['Some_Mod v1.2-56789-1-2.rar', '56789'],
    ['Harder VATS-1-1-0.7z', undefined],
    ['Harder VATS-01234-1-0.7z', undefined],
    ['Harder VATS 1.0.7z', undefined],
    ['Harder VATS-1234-1-0.esp', undefined],
    ['Harder VATS-99999999999-1-0.7z', undefined],
    ['', undefined],
  ])('is read from the name %s, when the metadata has none, as %s', (name, expected) => {
    expect(effectiveModId(undefined, name)).toBe(expected);
  });

  it('is the metadata\'s over the name\'s', () => {
    expect(effectiveModId('111', 'Harder VATS-1234-1-0.7z')).toBe('111');
  });

  it('is none for a folder, which has no name', () => {
    expect(effectiveModId(undefined, undefined)).toBeUndefined();
  });
});
