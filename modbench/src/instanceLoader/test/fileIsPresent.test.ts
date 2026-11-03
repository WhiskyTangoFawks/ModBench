import { describe, expect, it } from 'vitest';
import { FileConflictLookup } from '../fileConflictIndex';
import { filePresence } from '../fileIsPresent';
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
  dataFolderFiles: { kind: 'listed', files: new Set(['f4se/plugins/game.dll', 'fallout4 - main.ba2']) },
});

describe('filePresence: a file the game finds in its Data folder', () => {
  it.each([
    ['a file a mod provides, in any case and with either slash', 'f4se\\plugins\\X.dll'],
    ['a plugin a mod provides', 'provided.ESP'],
    ['a plugin the game loads with no line', 'dlcrobot.esm'],
    ['a plugin the Data folder lists', 'FALLOUT4.esm'],
    ['a file the game folder holds below its Data folder\'s root, in any case, with either slash', 'F4SE\\Plugins\\Game.DLL'],
    ['an archive the game folder holds', 'Fallout4 - Main.ba2'],
  ])('finds %s', (_name, path) => {
    expect(filePresence(value, path)).toBe('present');
  });

  it.each([
    ['a line that no file provides', 'LineOnly.esp'],
    ['a file nothing provides', 'Missing.esp'],
  ])('does not find %s', (_name, path) => {
    expect(filePresence(value, path)).toBe('absent');
  });
});

describe('filePresence: a file nothing provides while a listing of the Data folder is missing', () => {
  it.each([
    ['unresolved plugins', { dataFolderPlugins: { kind: 'unresolved' } }],
    ['unreadable plugins', { dataFolderPlugins: { kind: 'unreadable', reason: 'EACCES' } }],
    ['unresolved files', { dataFolderFiles: { kind: 'unresolved' } }],
    ['unreadable files', { dataFolderFiles: { kind: 'unreadable', reason: 'EACCES' } }],
  ] as const)('is unknown with %s', (_name, missing) => {
    expect(filePresence({ ...value, ...missing }, 'Missing.esp')).toBe('unknown');
  });

  it('is still present when a mod provides the file', () => {
    expect(filePresence({ ...value, dataFolderFiles: { kind: 'unreadable', reason: 'EACCES' } }, 'f4se/plugins/x.dll')).toBe('present');
  });
});
