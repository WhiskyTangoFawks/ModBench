import { describe, it, expect } from 'vitest';
import { joinedSentences, lastGoodReadMessage } from '../reasons';

describe('the message line saying a view shows the last good read', () => {
  it.each([
    ['says nothing with no reason', [], undefined],
    ['keeps a lone reason\'s full stop', ['mEdit is stopped.'], 'Showing the last good read: mEdit is stopped.'],
    ['drops a reason\'s full stop before the next', ['mEdit is stopped.', '"A.esp" (Data/): truncated'],
      'Showing the last good read: mEdit is stopped; "A.esp" (Data/): truncated'],
    ['keeps the last reason\'s full stop', ['one', 'two.'], 'Showing the last good read: one; two.'],
  ])('%s', (_case, reasons, message) => {
    expect(lastGoodReadMessage(reasons)).toBe(message);
  });
});

describe('statements joined into one message line', () => {
  it.each([
    ['ends a statement with no full stop before the next', ['Showing the last good read: bad', 'Failed to load: 503'], 'Showing the last good read: bad. Failed to load: 503'],
    ['keeps a statement\'s own full stop', ['Showing the last good read: stopped.', 'Failed to load: 503'], 'Showing the last good read: stopped. Failed to load: 503'],
    ['leaves the last statement as it is', ['Failed to load: 503'], 'Failed to load: 503'],
  ])('%s', (_case, statements, line) => {
    expect(joinedSentences(statements)).toBe(line);
  });
});
