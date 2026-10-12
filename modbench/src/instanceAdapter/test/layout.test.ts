import { describe, it, expect } from 'vitest';
import { join, matchesGlob } from 'node:path';
import { downloadNameAt, isPluginSourcePath, modDir, PLUGIN_SOURCE_GLOB } from '../layout';

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

  it.each([
    ['/mo2/source/Mod A/plugin-source/A.esp/Npcs/Npc.json', true],
    ['C:\\MO2\\Source\\Mod A\\Plugin-Source\\A.esp\\Npc.json', true],
    ['/mo2/mods/Mod A/plugin-source/A.esp/Npcs/Npc.json', false],
    ['/mo2/source/plugin-source/A.esp/Npc.json', false],
  ])('reads %s as plugin source: %s, only inside a mod\'s source folder beside mods/, in any case', (path, held) => {
    expect(isPluginSourcePath(path)).toBe(held);
    expect(matchesGlob(path.replaceAll('\\', '/'), PLUGIN_SOURCE_GLOB)).toBe(held);
  });
});
