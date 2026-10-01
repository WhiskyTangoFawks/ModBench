import { describe, it, expect } from 'vitest';
import { win32 } from 'node:path';
import { relativeUnder } from '../mo2Files';

describe('relativeUnder', () => {
  it('keys a Windows path with forward slashes', () => {
    const root = 'C:\\MO2\\mods\\Harder VATS';

    expect(relativeUnder(root, win32.join(root, 'Textures', 'a.dds'), win32.sep)).toBe('Textures/a.dds');
  });

  it('keeps a Linux path as it is', () => {
    expect(relativeUnder('/mo2/mods/Harder VATS', '/mo2/mods/Harder VATS/Textures/a.dds', '/')).toBe('Textures/a.dds');
  });
});
