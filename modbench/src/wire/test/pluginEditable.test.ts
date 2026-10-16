import { describe, it, expect } from 'vitest';
import { pluginCanBeEdited } from '../pluginEditable';

describe('whether a plugin\'s copy can be written (ADR-0007)', () => {
  const sourcePlugin = { isImmutable: false, isSourcePlugin: true, pluginSourceUnreadable: null };

  it('is so for a source plugin outside the game folder whose source reads', () => {
    expect(pluginCanBeEdited(sourcePlugin)).toBe(true);
  });

  it.each([
    ['nonSourcePlugin', { isSourcePlugin: false }],
    ['the game\'s', { isImmutable: true }],
    ['source-unreadable', { pluginSourceUnreadable: 'missing' }],
  ])('is not for a %s plugin', (_, over) => {
    expect(pluginCanBeEdited({ ...sourcePlugin, ...over })).toBe(false);
  });
});
