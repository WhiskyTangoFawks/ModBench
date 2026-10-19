import { describe, it, expect } from 'vitest';
import { samePath } from '../samePath';

describe('samePath', () => {
  it.each([
    ['C:\\MO2\\downloads\\Foo.7z', 'c:\\mo2\\Downloads\\Foo.7z', 'win32', true],
    ['C:\\MO2\\downloads\\Foo.7z', 'C:\\MO2\\downloads\\.\\Foo.7z', 'win32', true],
    ['C:\\MO2\\downloads\\Foo.7z', 'C:\\Elsewhere\\Foo.7z', 'win32', false],
    ['/mo2/downloads/Foo.7z', '/mo2/downloads/Foo.7z', 'linux', true],
    ['/mo2/downloads/Foo.7z', '/mo2/downloads/./Foo.7z', 'linux', true],
    ['/mo2/downloads/Foo.7z', '/mo2/Downloads/Foo.7z', 'linux', false],
  ] as const)('%s and %s on %s: %s', (a, b, platform, same) => {
    expect(samePath(a, b, platform)).toBe(same);
  });
});
