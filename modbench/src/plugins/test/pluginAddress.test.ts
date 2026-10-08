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
    facts.append({ name: 'A.esp', origin: 'ModA' }, 'two');
    expect(facts.get({ name: 'A.esp', origin: 'ModA' })).toEqual(['one', 'two']);
  });

  it('keeps two addresses that differ only in case apart', () => {
    const facts = new ByPluginAddress<string>();
    facts.set({ name: 'Foo.esp', origin: 'ModA' }, 'upper');
    facts.set({ name: 'foo.esp', origin: 'ModA' }, 'lower');
    expect(facts.get({ name: 'Foo.esp', origin: 'ModA' })).toBe('upper');
    expect(facts.get({ name: 'foo.esp', origin: 'ModA' })).toBe('lower');
  });

  it('reads nothing for a spelling that could be either of two twins', () => {
    const facts = new ByPluginAddress<string>();
    facts.set({ name: 'Foo.esp', origin: 'ModA' }, 'upper');
    facts.set({ name: 'foo.esp', origin: 'ModA' }, 'lower');
    expect(facts.get({ name: 'FOO.esp', origin: 'ModA' })).toBeUndefined();
    expect(facts.has({ name: 'FOO.esp', origin: 'ModA' })).toBe(false);
  });
});
