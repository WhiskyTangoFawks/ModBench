import { describe, it, expect } from 'vitest';
import { join, matchesGlob } from 'node:path';
import { isPluginSourcePath, manifestFileIn, modDir, PLUGIN_SOURCE_GLOB, tempOwner } from '../layout';

const ROOT = join('/tmp', 'instance');

describe('MO2 layout', () => {
  it('names a mod\'s manifest for the mod, with the JSON suffix', () => {
    expect(manifestFileIn(join('mods', 'Mod A'), 'Mod A')).toBe(join('mods', 'Mod A', 'Mod A.manifest.json'));
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

describe('tempOwner', () => {
  it('reads the process id from the name', () => {
    expect(tempOwner('.medit_tmp_4242_x.tmp')).toBe(4242);
  });

  it.each(['.medit_tmp__x.tmp', '.medit_tmp_0_x.tmp', '.medit_tmp_-3_x', '.medit_tmp_abc_x'])('reads no owner from %s', (name) => {
    expect(tempOwner(name)).toBeUndefined();
  });
});
