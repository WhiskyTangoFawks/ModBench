import { describe, it, expect } from 'vitest';
import { qtToInt } from '../../codecs/qtInt';

describe('qtToInt', () => {
  it.each([
    ['3', 3], [' 12 ', 12], ['-5', -5], ['+7', 7], ['2147483647', 2147483647], ['-2147483648', -2147483648],
    ['2147483648', 0], ['0x10', 0], ['1e2', 0], ['1.5', 0], ['abc', 0], ['', 0],
  ])('reads %j as %s', (text, expected) => {
    expect(qtToInt(text)).toBe(expected);
  });
});
