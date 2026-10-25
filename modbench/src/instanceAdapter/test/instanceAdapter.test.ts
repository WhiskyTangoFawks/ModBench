import { describe, it, expect } from 'vitest';
import { matchesGlob } from 'node:path';
import { isPluginSourcePath, PLUGIN_SOURCE_GLOB } from '../instanceAdapter';

describe('plugin source', () => {
  it.each([
    ['/mo2/source/Mod A/plugin-source/A.esp/Npcs/Npc.json', true],
    ['C:\\MO2\\Source\\Mod A\\Plugin-Source\\A.esp\\Npc.json', true],
    ['/mo2/source/Mod A/assets/Notes.json', false],
    ['/mo2/mods/Mod A/plugin-source/A.esp/Npcs/Npc.json', false],
    ['/mo2/source/plugin-source/A.esp/Npc.json', false],
  ])('reads %s as plugin source: %s, only inside a mod\'s source folder beside mods/, in any case', (path, held) => {
    expect(isPluginSourcePath(path)).toBe(held);
    expect(matchesGlob(path.replaceAll('\\', '/'), PLUGIN_SOURCE_GLOB)).toBe(held);
  });
});
