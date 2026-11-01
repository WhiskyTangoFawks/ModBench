import { describe, expect, it } from 'vitest';
import { FileConflictLookup } from '../fileConflictIndex';
import { fileIsPresent } from '../fileIsPresent';
import { instanceValueFixture } from '../../test/mo2/instanceValueFixture';

const files = new FileConflictLookup();
files.set({ relativePath: 'F4SE/Plugins/x.dll', winner: '/m/x.dll', winnerOrigin: { kind: 'mod', name: 'M' }, providers: [{ kind: 'mod', name: 'M' }] });

const value = instanceValueFixture({
  files,
  plugins: [
    { name: 'Provided.esp', path: '/m/Provided.esp', origin: 'M', line: 0, enabled: true, winning: true },
    { name: 'LineOnly.esp', path: undefined, origin: 'M', line: 1, enabled: true, winning: true },
  ],
  pluginsLoadedWithNoLine: [{ name: 'DLCRobot.esm', origin: 'Data/', path: '/game/Data/DLCRobot.esm' }],
  dataFolderPlugins: { kind: 'listed', names: new Set(['Fallout4.esm']) },
});

describe('fileIsPresent: a file the game finds in its Data folder', () => {
  it.each([
    ['a file a mod provides, in any case and with either slash', 'f4se\\plugins\\X.dll'],
    ['a plugin a mod provides', 'provided.ESP'],
    ['a plugin the game loads with no line', 'dlcrobot.esm'],
    ['a plugin the Data folder lists', 'FALLOUT4.esm'],
  ])('finds %s', (_name, path) => {
    expect(fileIsPresent(value, path)).toBe(true);
  });

  it.each([
    ['a line that no file provides', 'LineOnly.esp'],
    ['a file nothing provides', 'Missing.esp'],
  ])('does not find %s', (_name, path) => {
    expect(fileIsPresent(value, path)).toBe(false);
  });
});
