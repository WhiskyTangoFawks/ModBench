import { describe, it, expect } from 'vitest';
import { win32 } from 'node:path';
import { relativeUnder } from '../mo2Files';

describe('relativeUnder', () => {
  it('keys a Windows path with forward slashes, as path.relative and a separator join did', () => {
    const root = 'C:\\MO2\\mods\\Harder VATS';
    const path = win32.join(root, 'Textures', 'a.dds');

    expect(relativeUnder(root, path, win32.sep)).toBe('Textures/a.dds');
    expect(relativeUnder(root, path, win32.sep)).toBe(win32.relative(root, path).split(win32.sep).join('/'));
  });

  it('keeps a Linux path as it is', () => {
    expect(relativeUnder('/mo2/mods/Harder VATS', '/mo2/mods/Harder VATS/Textures/a.dds', '/')).toBe('Textures/a.dds');
  });
});
