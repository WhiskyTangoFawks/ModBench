import { describe, it, expect } from 'vitest';
import type { EntryRef, TakenNames } from '../../instanceAdapter/instanceAdapter';
import { fakeInstanceAdapter } from '../../test/fakeInstanceAdapter';
import { entryNameRefusal, newModNameRefusal } from '../nameRefusals';

const mod = (name: string) => ({ kind: 'mod', name } as const);
const separator = (name: string) => ({ kind: 'separator', name } as const);
const folder = (kind: 'mod' | 'separator', name: string) => ({ kind, name, path: `/instance/mods/${name}`, modName: name });

const { adapter } = fakeInstanceAdapter();
const key = (entry: EntryRef): string => adapter.entryKey(entry);

const taken: TakenNames = {
  mods: [mod('Listed Only'), mod('Harder VATS'), separator('Group A')],
  modFolders: [folder('mod', 'Harder VATS'), folder('mod', 'Folder Only'), folder('separator', 'Group A')],
};

describe('newModNameRefusal', () => {
  it('names the collision and the way out when a folder holds a mod of that name', () => {
    expect(newModNameRefusal(key, taken, 'Harder VATS')).toBe(
      'A mod named "Harder VATS" already exists. Install its next release from Downloads, or uninstall it to install anew.');
  });

  it('names the collision for a mod of that name in another case, in the name as given, so the prompt does not accept a name the create or the install then refuses', () => {
    expect(newModNameRefusal(key, taken, 'harder vats')).toMatch(/"harder vats" already exists/);
  });

  it.each([
    ['a free name', 'A New Mod'],
    ['a separator\'s name', 'Group A'],
    ['a name only mod order lists', 'Listed Only'],
    ['a blank name', '   '],
  ])('is silent for %s', (_case, name) => {
    expect(newModNameRefusal(key, taken, name)).toBeUndefined();
  });

  it('checks the name trimmed', () => {
    expect(newModNameRefusal(key, taken, '  Harder VATS ')).toMatch(/"Harder VATS" already exists/);
  });

  it('names the collision for the name of a separator\'s folder, the manager knowing a mod by its folder\'s name', () => {
    expect(newModNameRefusal(key, taken, 'group a_SEPARATOR')).toMatch(/"group a_SEPARATOR" already exists/);
  });

  it('is silent while the instance has no folder for mods', () => {
    expect(newModNameRefusal(key, { mods: [], modFolders: undefined }, 'Harder VATS')).toBeUndefined();
  });
});

describe('entryNameRefusal', () => {
  it.each<[string, EntryRef['kind'], string, string | undefined, string | undefined]>([
    ['refuses a name another mod has listed, without case', 'mod', 'listed only', undefined, 'clash'],
    ['refuses a name another mod\'s folder has, without case', 'mod', 'FOLDER ONLY', undefined, 'clash'],
    ['refuses a name another separator has, without case', 'separator', 'group a', 'Group B', 'clash'],
    ['refuses a mod name a separator\'s folder is named', 'mod', 'group a_separator', 'Harder VATS', 'clash'],
    ['takes the entry\'s own name in any case', 'mod', 'harder vats', 'Harder VATS', undefined],
    ['takes a name only the other kind has', 'mod', 'Group A', 'Harder VATS', undefined],
  ])('%s', (_case, kind, requested, own, expected) => {
    expect(entryNameRefusal(key, taken, kind, requested, 'clash', own)).toBe(expected);
  });
});
