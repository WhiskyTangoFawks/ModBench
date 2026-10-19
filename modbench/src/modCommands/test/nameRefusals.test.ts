import { describe, it, expect } from 'vitest';
import type { TakenNames } from '../../instanceAdapter/instanceAdapter';
import { entryNameRefusal, newModNameRefusal } from '../nameRefusals';

const mod = (name: string) => ({ kind: 'mod', name } as const);
const separator = (name: string) => ({ kind: 'separator', name } as const);
const folder = (kind: 'mod' | 'separator', name: string) => ({ kind, name, path: `/instance/mods/${name}`, modName: name });

const key = (entry: { kind: string; name: string }): string =>
  (entry.kind === 'separator' ? `${entry.name.trim().replace(/\.+$/, '')}_separator` : entry.name).toLowerCase();

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

  it('is silent for a free name, a separator\'s name, a name only mod order lists, and a blank one', () => {
    expect(newModNameRefusal(key, taken, 'A New Mod')).toBeUndefined();
    expect(newModNameRefusal(key, taken, 'Group A')).toBeUndefined();
    expect(newModNameRefusal(key, taken, 'Listed Only')).toBeUndefined();
    expect(newModNameRefusal(key, taken, '   ')).toBeUndefined();
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
  it('refuses a name another entry of the kind has, listed or in a folder, without case', () => {
    expect(entryNameRefusal(key, taken, 'mod', 'listed only', 'clash')).toBe('clash');
    expect(entryNameRefusal(key, taken, 'mod', 'FOLDER ONLY', 'clash')).toBe('clash');
    expect(entryNameRefusal(key, taken, 'separator', 'group a', 'clash', 'Group B')).toBe('clash');
  });

  it('names the collision for a name a separator\'s folder is named, and for a separator\'s name the manager folds to it', () => {
    expect(entryNameRefusal(key, taken, 'mod', 'group a_separator', 'clash', 'Harder VATS')).toBe('clash');
    expect(entryNameRefusal(key, taken, 'separator', ' group a. ', 'clash', 'Group B')).toBe('clash');
  });

  it('takes the entry\'s own name in any case, and a name only the other kind has', () => {
    expect(entryNameRefusal(key, taken, 'mod', 'harder vats', 'clash', 'Harder VATS')).toBeUndefined();
    expect(entryNameRefusal(key, taken, 'mod', 'Group A', 'clash', 'Harder VATS')).toBeUndefined();
  });
});
