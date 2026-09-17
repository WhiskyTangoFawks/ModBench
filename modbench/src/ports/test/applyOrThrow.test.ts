import { describe, it, expect } from 'vitest';
import { applyOrThrow } from '../applyOrThrow';

describe('applyOrThrow', () => {
  it('returns quietly when the outcome applied', () => {
    expect(() => applyOrThrow({ applied: true })).not.toThrow();
  });

  it('throws the refusal when the outcome did not apply', () => {
    expect(() => applyOrThrow({ applied: false, refusal: 'locked' })).toThrow('locked');
  });
});
