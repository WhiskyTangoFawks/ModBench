import { describe, it, expect } from 'vitest';
import { nexusModIdOfFileName } from '../../codecs/nexusFileName';

describe('the Nexus mod ID in a file name', () => {
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
  ])('is read from %s as %s', (name, expected) => {
    expect(nexusModIdOfFileName(name)).toBe(expected);
  });
});
