import { describe, expect, it } from 'vitest';
import { FileConflictLookup } from '../fileConflictIndex';
import { fileIsPresent } from '../fileIsPresent';

const files = new FileConflictLookup();
files.set({ relativePath: 'F4SE/Plugins/x.dll', winner: '/m/x.dll', winnerOrigin: { kind: 'mod', name: 'M' }, providers: [{ kind: 'mod', name: 'M' }] });
const value = { files, plugins: [{ name: 'Fallout4.esm', path: undefined, origin: 'Data', line: null, enabled: false, winning: true }] };

describe('fileIsPresent', () => {
  it.each([
    ['a file a mod provides, in any case and with either slash', 'f4se\\plugins\\X.dll', true],
    ['a plugin the instance holds, which the game folder may provide', 'fallout4.ESM', true],
    ['a file nothing provides', 'Missing.esp', false],
  ])('answers %s', (_name, path, present) => {
    expect(fileIsPresent(value, path)).toBe(present);
  });
});
