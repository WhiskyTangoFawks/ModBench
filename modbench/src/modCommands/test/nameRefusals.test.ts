import { describe, it, expect } from 'vitest';
import { fakeInstanceAdapter, modFoldersOf, readingFixture } from '../../test/fakeInstanceAdapter';
import { modCommands } from '../modCommands';

const mod = (name: string) => ({ kind: 'mod', name, enabled: true } as const);
const separator = (name: string) => ({ kind: 'separator', name, enabled: true } as const);

const commandsOver = (modFolders = modFoldersOf('Harder VATS', 'Folder Only', { kind: 'separator', name: 'Group A' })) =>
  modCommands(fakeInstanceAdapter(readingFixture({ mods: [mod('Listed Only'), mod('Harder VATS'), separator('Group A')], modFolders })).adapter);

describe('the name of a new mod', () => {
  it.each([
    ['a free name', 'A New Mod'],
    ['a separator\'s name', 'Group A'],
    ['a name only mod order lists', 'Listed Only'],
    ['a blank name', '   '],
  ])('is silent for %s', async (_case, name) => {
    expect(await commandsOver().newModNameRefusal(name)).toBeUndefined();
  });

  it('checks the name trimmed', async () => {
    expect(await commandsOver().newModNameRefusal('  Harder VATS ')).toMatch(/"Harder VATS" already exists/);
  });

  it('names the collision for the name of a separator\'s folder, the manager knowing a mod by its folder\'s name', async () => {
    expect(await commandsOver().newModNameRefusal('group a_SEPARATOR')).toMatch(/"group a_SEPARATOR" already exists/);
  });

  it('is silent while the instance has no folder for mods', async () => {
    expect(await modCommands(fakeInstanceAdapter(readingFixture({ mods: [mod('Harder VATS')] })).adapter).newModNameRefusal('Harder VATS')).toBeUndefined();
  });
});

describe('the new name of a mod', () => {
  it.each<[string, string, string | undefined]>([
    ['refuses a mod name a separator\'s folder is named', 'group a_separator', 'A mod with this name already exists'],
    ['takes a name only the other kind has', 'Group A', undefined],
  ])('%s', async (_case, requested, expected) => {
    expect(await commandsOver().renameModNameRefusal(requested, 'Harder VATS')).toBe(expected);
  });
});
