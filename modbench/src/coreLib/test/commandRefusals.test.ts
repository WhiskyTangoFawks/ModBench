import { describe, it, expect } from 'vitest';
import { entryNameRefusal, newModNameRefusal, type TakenNames } from '../commandRefusals';

const mod = (name: string) => ({ kind: 'mod', name } as const);
const separator = (name: string) => ({ kind: 'separator', name } as const);

const taken: TakenNames = {
  mods: [mod('Listed Only'), mod('Harder VATS'), separator('Group A')],
  modFolders: [mod('Harder VATS'), mod('Folder Only'), separator('Group A')],
};

describe('newModNameRefusal', () => {
  it('names the collision and points at the Downloads view when a folder holds a mod of that name', () => {
    expect(newModNameRefusal(taken, 'Harder VATS')).toBe(
      'A mod named "Harder VATS" already exists — install its next release from the Downloads view instead.');
  });

  it('names the collision for a mod of that name in another case, in the name as given, so the prompt does not accept a name the create or the install then refuses', () => {
    expect(newModNameRefusal(taken, 'harder vats')).toMatch(/"harder vats" already exists/);
  });

  it('is silent for a free name, a separator\'s name, a name only mod order lists, and a blank one', () => {
    expect(newModNameRefusal(taken, 'A New Mod')).toBeUndefined();
    expect(newModNameRefusal(taken, 'Group A')).toBeUndefined();
    expect(newModNameRefusal(taken, 'Listed Only')).toBeUndefined();
    expect(newModNameRefusal(taken, '   ')).toBeUndefined();
  });

  it('checks the name trimmed', () => {
    expect(newModNameRefusal(taken, '  Harder VATS ')).toMatch(/"Harder VATS" already exists/);
  });

  it('is silent while the instance has no folder for mods', () => {
    expect(newModNameRefusal({ mods: [], modFolders: undefined }, 'Harder VATS')).toBeUndefined();
  });
});

describe('entryNameRefusal', () => {
  it('refuses a name another entry of the kind has, listed or in a folder, without case', () => {
    expect(entryNameRefusal(taken, 'mod', 'listed only', 'clash')).toBe('clash');
    expect(entryNameRefusal(taken, 'mod', 'FOLDER ONLY', 'clash')).toBe('clash');
    expect(entryNameRefusal(taken, 'separator', 'group a', 'clash', 'Group B')).toBe('clash');
  });

  it('takes the entry\'s own name in any case, and a name only the other kind has', () => {
    expect(entryNameRefusal(taken, 'mod', 'harder vats', 'clash', 'Harder VATS')).toBeUndefined();
    expect(entryNameRefusal(taken, 'mod', 'Group A', 'clash', 'Harder VATS')).toBeUndefined();
  });
});
