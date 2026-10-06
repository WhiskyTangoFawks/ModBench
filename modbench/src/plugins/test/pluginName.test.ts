import { describe, it, expect } from 'vitest';
import { pluginNameRefusal } from '../pluginName';

const ALL = ['.esp', '.esm', '.esl'];

describe('pluginNameRefusal', () => {
  it.each(['MyPatch.esp', 'MyPatch.ESM', 'MyPatch.esl'])('accepts %s where mEdit allows every extension', (name) => {
    expect(pluginNameRefusal(name, ALL)).toBeUndefined();
  });

  it('refuses an empty name', () => {
    expect(pluginNameRefusal('', ALL)).toBe('Name is required');
  });

  it.each(['MyPatch.txt', 'MyPatch', '.esp'])('refuses %s, naming the extensions mEdit allows', (name) => {
    expect(pluginNameRefusal(name, ALL)).toBe('Extension must be .esp, .esm, or .esl');
  });

  it('refuses an extension mEdit leaves out, in any case, naming the ones it allows', () => {
    expect(pluginNameRefusal('MyPatch.ESL', ['.esp', '.esm'])).toBe('Extension must be .esp or .esm');
    expect(pluginNameRefusal('MyPatch.esp', ['.esp', '.esm'])).toBeUndefined();
  });
});
