import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { downloadNameAt, modDir } from '../layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names the downloaded file at a path as the platform matches paths, not by exact comparison, which misses the path a Windows picker hands back in another case', () => {
    expect(downloadNameAt('C:\\MO2\\downloads', 'c:\\mo2\\Downloads\\Foo.7z', 'win32')).toBe('Foo.7z');
    expect(downloadNameAt('/mo2/downloads', '/mo2/downloads/Foo.7z', 'linux')).toBe('Foo.7z');
    expect(downloadNameAt('/mo2/downloads', '/mo2/Downloads/Foo.7z', 'linux')).toBeUndefined();
    expect(downloadNameAt('C:\\MO2\\downloads', 'C:\\Elsewhere\\Foo.7z', 'win32')).toBeUndefined();
  });

  it('joins a name with separators in it as one more path segment, never as a second argument', () => {
    expect(modDir(ROOT, 'A/B')).toBe(join(ROOT, 'mods', 'A/B'));
  });
});
