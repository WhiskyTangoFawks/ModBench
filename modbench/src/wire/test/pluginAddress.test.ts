import { describe, it, expect } from 'vitest';
import { ByPluginAddress, pluginAddressKey, samePluginAddress } from '../pluginAddress';

describe('a plugin is its origin and filename (ADR-0012)', () => {
  it('compares without case', () => {
    expect(samePluginAddress({ name: 'A.esp', origin: 'ModA' }, { name: 'a.ESP', origin: 'moda' })).toBe(true);
  });

  it('keeps two plugins that share a filename apart', () => {
    const a = { name: 'Shared.esp', origin: 'ModA' };
    const b = { name: 'Shared.esp', origin: 'ModB' };
    expect(samePluginAddress(a, b)).toBe(false);
    expect(pluginAddressKey(a)).not.toBe(pluginAddressKey(b));
  });

  it('files a fact under the address and reads it back case-insensitively', () => {
    const facts = new ByPluginAddress<string>();
    facts.set({ name: 'A.esp', origin: 'ModA' }, 'x');
    expect(facts.get({ name: 'a.esp', origin: 'MODA' })).toBe('x');
    expect(facts.has({ name: 'A.esp', origin: 'ModB' })).toBe(false);
  });

  it('appends under one address', () => {
    const facts = new ByPluginAddress<string[]>();
    facts.append({ name: 'A.esp', origin: 'ModA' }, 'one');
    facts.append({ name: 'a.esp', origin: 'moda' }, 'two');
    expect(facts.get({ name: 'A.esp', origin: 'ModA' })).toEqual(['one', 'two']);
  });
});
