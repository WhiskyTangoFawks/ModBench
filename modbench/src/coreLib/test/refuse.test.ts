import { describe, it, expect } from 'vitest';
import { refuse } from '../refuse';

describe('refuse', () => {
  it('turns a caught Error into a refusal carrying its message', () => {
    expect(refuse(new Error('disk full'))).toEqual({ applied: false, refusal: 'disk full' });
  });

  it('turns a caught non-Error into a refusal carrying its stringification', () => {
    expect(refuse('boom')).toEqual({ applied: false, refusal: 'boom' });
  });
});
