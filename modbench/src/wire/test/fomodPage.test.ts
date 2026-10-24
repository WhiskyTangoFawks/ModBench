import { describe, expect, it } from 'vitest';
import { parseFomodMove, parseFomodShown } from '../fomodPage';

describe('the messages of the FOMOD page', () => {
  const state = { module: 'M', steps: [], current: 0 };

  it.each([
    ['the state the host shows', { type: 'fomodState', state }, { type: 'fomodState', state }],
    ['nothing from a message of another type', { type: 'other', state }, undefined],
  ])('the page reads %s', (_, message, shown) => {
    expect(parseFomodShown(message)).toEqual(shown);
  });

  it.each([
    ['a move it knows', { type: 'fomodMove', move: { kind: 'manual' } }, { kind: 'manual' }],
    ['nothing from a move it does not know', { type: 'fomodMove', move: { kind: 'format' } }, undefined],
  ])('the host reads %s', (_, message, move) => {
    expect(parseFomodMove(message)).toEqual(move);
  });
});
