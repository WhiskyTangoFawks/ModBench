import { describe, expect, it } from 'vitest';
import { pluginPlacesOf } from '../pluginPlacesOf';

describe('where a new plugin can live', () => {
  const value = {
    mods: [
      { kind: 'mod' as const, name: 'ModA', enabled: true }, { kind: 'mod' as const, name: 'ModB', enabled: false },
      { kind: 'separator' as const, name: 'Weapons', enabled: true }, { kind: 'mod' as const, name: 'ModGone', enabled: true },
      { kind: 'mod' as const, name: 'ModC', enabled: true },
    ],
    paths: {
      overwriteDir: '/mo2/overwrite', downloadsDir: undefined,
      modDirs: new Map([['ModA', '/mods/ModA'], ['ModB', '/mods/ModB'], ['Weapons', '/mods/Weapons_separator'], ['ModC', '/mods/ModC']]),
      sourceDirs: new Map([['ModA', '/source/ModA']]),
    },
  };

  it('offers each enabled mod that has a folder, a source mod with its source folder, then Overwrite, and no disabled mod, separator or mod without a folder', () => {
    expect(pluginPlacesOf(value)).toEqual([
      { name: 'ModA', folder: '/mods/ModA', sourceFolder: '/source/ModA' },
      { name: 'ModC', folder: '/mods/ModC' },
      { name: 'overwrite/', folder: '/mo2/overwrite' },
    ]);
  });

  it('offers no Overwrite while its folder is unread', () => {
    expect(pluginPlacesOf({ ...value, paths: { ...value.paths, overwriteDir: undefined } }).map((place) => place.name)).toEqual(['ModA', 'ModC']);
  });
});
