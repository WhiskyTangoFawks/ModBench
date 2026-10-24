import { describe, it, expect } from 'vitest';
import { errorMessage } from '../errorMessage';

describe('errorMessage', () => {
  it.each<[string, unknown, string]>([
    ['reads the message off an Error', new Error('disk full'), 'disk full'],
    ['stringifies a thrown string', 'boom', 'boom'],
    ['stringifies a thrown number', 42, '42'],
  ])('%s', (_case, thrown, expected) => {
    expect(errorMessage(thrown)).toBe(expected);
  });
});
