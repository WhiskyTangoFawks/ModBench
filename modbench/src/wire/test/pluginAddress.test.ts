import { describe, it, expect } from 'vitest';
import { pluginAddressKey, samePluginAddress } from '../pluginAddress';

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
});
