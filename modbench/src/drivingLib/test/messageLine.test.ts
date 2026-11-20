import { describe, it, expect } from 'vitest';
import { messageLine } from '../messageLine';

describe('one view\'s message line, said by several writers', () => {
  it.each([
    ['says nothing when no writer does', [undefined, undefined], undefined],
    ['ends a part with no full stop before the next', ['Showing the last good read: bad', undefined, 'Failed to load: 503'], 'Showing the last good read: bad. Failed to load: 503'],
    ['keeps a part\'s own full stop', ['Showing the last good read: stopped.', 'Failed to load: 503'], 'Showing the last good read: stopped. Failed to load: 503'],
    ['leaves the last part as it is', ['Failed to load: 503'], 'Failed to load: 503'],
  ])('%s', (_case, parts, line) => {
    expect(messageLine(...parts)).toBe(line);
  });
});
