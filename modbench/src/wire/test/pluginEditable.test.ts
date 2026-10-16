import { describe, it, expect } from 'vitest';
import { pluginCanBeEdited } from '../pluginEditable';

describe('whether a plugin\'s copy can be written (ADR-0007)', () => {
  const compiledPlugin = { isImmutable: false, isCompiledPlugin: true, pluginSourceUnreadable: null };

  it('is so for a compiled plugin outside the game folder whose source reads', () => {
    expect(pluginCanBeEdited(compiledPlugin)).toBe(true);
  });

  it.each([
    ['nonCompiledPlugin', { isCompiledPlugin: false }],
    ['the game\'s', { isImmutable: true }],
    ['source-unreadable', { pluginSourceUnreadable: 'missing' }],
  ])('is not for a %s plugin', (_, over) => {
    expect(pluginCanBeEdited({ ...compiledPlugin, ...over })).toBe(false);
  });
});
