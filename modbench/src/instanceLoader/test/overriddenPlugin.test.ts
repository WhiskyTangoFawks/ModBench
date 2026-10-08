import { describe, it, expect } from 'vitest';
import { overridingOrigin } from '../overriddenPlugin';
import type { LoadOrderPlugin } from '../loadOrderSnapshot';

const row = (over: Partial<LoadOrderPlugin>): LoadOrderPlugin =>
  ({ name: 'A.esp', path: '/mods/ModA/A.esp', origin: 'ModA', line: 0, enabled: true, winning: true, ...over });
const A = { name: 'A.esp', origin: 'ModA' };

describe('the file that overrides a plugin', () => {
  it('is the enabled winning file of its filename, from another origin', () => {
    expect(overridingOrigin({ plugins: [row({ winning: false }), row({ origin: 'ModB' })] }, A)).toBe('ModB');
  });

  it('is none for the plugin that wins', () => {
    expect(overridingOrigin({ plugins: [row({}), row({ origin: 'ModB', winning: false })] }, A)).toBeUndefined();
  });

  it('is none when the filename\'s line is disabled', () => {
    expect(overridingOrigin({ plugins: [row({ winning: false, enabled: false }), row({ origin: 'ModB', enabled: false })] }, A)).toBeUndefined();
  });

  it('is none for a plugin the instance does not list', () => {
    expect(overridingOrigin({ plugins: [] }, A)).toBeUndefined();
  });
});
