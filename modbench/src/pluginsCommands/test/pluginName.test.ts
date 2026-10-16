import { describe, it, expect } from 'vitest';
import { pluginNameRefusal } from '../pluginName';

const ALL = ['.esm', '.esl', '.esp'];

describe('pluginNameRefusal', () => {
  it.each(['MyPatch.esp', 'MyPatch.ESM', 'MyPatch.esl'])('accepts %s where mEdit allows every extension', (name) => {
    expect(pluginNameRefusal(name, ALL)).toBeUndefined();
  });

  it('refuses an empty name', () => {
    expect(pluginNameRefusal('', ALL)).toBe('Name is required');
  });

  it.each(['MyPatch.txt', 'MyPatch', '.esp', 'Folder/.esp'])('refuses %s, naming the extensions mEdit allows', (name) => {
    expect(pluginNameRefusal(name, ALL)).toBe('Extension must be .esm, .esl, or .esp');
  });

  it('refuses an extension mEdit leaves out, in any case, naming the ones it allows', () => {
    expect(pluginNameRefusal('MyPatch.ESL', ['.esm', '.esp'])).toBe('Extension must be .esm or .esp');
    expect(pluginNameRefusal('MyPatch.esp', ['.esm', '.esp'])).toBeUndefined();
  });
});
