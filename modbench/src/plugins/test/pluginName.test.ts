import { describe, it, expect } from 'vitest';
import { pluginNameRefusal } from '../pluginName';

describe('pluginNameRefusal', () => {
  it.each(['MyPatch.esp', 'MyPatch.ESM', 'MyPatch.esl'])('accepts %s where the game has light plugins', (name) => {
    expect(pluginNameRefusal(name, true)).toBeUndefined();
  });

  it('refuses an empty name', () => {
    expect(pluginNameRefusal('', true)).toBe('Name is required');
  });

  it('refuses a name that does not end .esp, .esm or .esl', () => {
    expect(pluginNameRefusal('MyPatch.txt', true)).toBe('Extension must be .esp, .esm, or .esl');
  });

  it('refuses .esl, in any case, where the game has no light plugins', () => {
    expect(pluginNameRefusal('MyPatch.ESL', false)).toBe('This game has no light plugins');
    expect(pluginNameRefusal('MyPatch.esp', false)).toBeUndefined();
  });
});
