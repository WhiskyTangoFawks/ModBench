import { describe, it, expect } from 'vitest';
import { lastGoodReadMessage } from '../reasons';

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
