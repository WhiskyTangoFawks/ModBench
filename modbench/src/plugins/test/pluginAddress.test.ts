import { describe, it, expect } from 'vitest';
import { ByPluginAddress } from '../pluginAddress';

describe('a fact is filed under origin and filename (ADR-0012)', () => {
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
