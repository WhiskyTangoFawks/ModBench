import { describe, it, expect } from 'vitest';
import { errorMessage } from '../errorMessage';

describe('errorMessage', () => {
  it('reads the message off an Error', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full');
  });

  it('stringifies a thrown non-Error', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(42)).toBe('42');
  });
});
