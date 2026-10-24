import { describe, expect, it } from 'vitest';
import { parseFomodMove, parseFomodShown } from '../fomodPage';

describe('the messages of the FOMOD page', () => {
  it('reads what the host shows and what the page sends, and nothing else', () => {
    const state = { module: 'M', steps: [], current: 0 };
    expect(parseFomodShown({ type: 'fomodState', state })?.state).toEqual(state);
    expect(parseFomodShown({ type: 'other', state })).toBeUndefined();
    expect(parseFomodMove({ type: 'fomodMove', move: { kind: 'manual' } })).toEqual({ kind: 'manual' });
    expect(parseFomodMove({ type: 'fomodMove', move: { kind: 'format' } })).toBeUndefined();
  });
});
