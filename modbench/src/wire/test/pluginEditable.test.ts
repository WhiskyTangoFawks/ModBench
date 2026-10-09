import { describe, it, expect } from 'vitest';
import { pluginCanBeEdited } from '../pluginEditable';

describe('whether a plugin\'s copy can be written (ADR-0007)', () => {
  const tracked = { isImmutable: false, isTracked: true, pluginSourceUnreadable: null };

  it('is so for a tracked plugin outside the game folder whose source reads', () => {
    expect(pluginCanBeEdited(tracked)).toBe(true);
  });

  it.each([
    ['untracked', { isTracked: false }],
    ['the game\'s', { isImmutable: true }],
    ['source-unreadable', { pluginSourceUnreadable: 'missing' }],
  ])('is not for a %s plugin', (_, over) => {
    expect(pluginCanBeEdited({ ...tracked, ...over })).toBe(false);
  });
});
