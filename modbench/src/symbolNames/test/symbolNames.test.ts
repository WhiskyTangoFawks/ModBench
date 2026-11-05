import { describe, expect, it } from 'vitest';
import { heldTextAt, heldTexts, namesPlugin, placeIn, pluginNamed, samePath } from '../symbolNames';

const winning = { name: 'Shared.esp', origin: 'Late', winning: true };
const losing = { name: 'Shared.esp', origin: 'Early', winning: false };
const plugins = [losing, winning];

describe('a name in a file resolves to its plugin (symbols.md, The symbols, Plugin)', () => {
  it('a file name alone names the copy mod order resolves it to, in any case', () => {
    expect(namesPlugin({ name: 'shared.ESP' }, { name: 'Shared.esp', origin: 'Late' }, plugins)).toBe(true);
    expect(namesPlugin({ name: 'Shared.esp' }, { name: 'Shared.esp', origin: 'Early' }, plugins)).toBe(false);
  });

  it('a file name alone that mod order resolves to no copy names no plugin', () => {
    expect(namesPlugin({ name: 'Shared.esp' }, losing, [losing])).toBe(false);
    expect(pluginNamed({ name: 'Shared.esp' }, [losing])).toBeUndefined();
  });

  it('a file name alone names its copy as the instance spells it', () => {
    expect(pluginNamed({ name: 'shared.ESP' }, plugins)).toEqual({ name: 'Shared.esp', origin: 'Late' });
  });

  it('a file name with the mod that holds it names that copy, won or not', () => {
    expect(namesPlugin({ name: 'Shared.esp', origin: 'early' }, { name: 'Shared.esp', origin: 'Early' }, plugins)).toBe(true);
    expect(namesPlugin({ name: 'Shared.esp', origin: 'Early' }, { name: 'Shared.esp', origin: 'Late' }, plugins)).toBe(false);
  });
});

describe('unsaved text, by its file', () => {
  it('is found for a path that spells the drive letter in the other case', () => {
    const held = heldTexts([['c:\\Mods\\A\\build.json', '{}']]);

    expect(heldTextAt(held, 'C:\\Mods\\A\\build.json')).toBe('{}');
    expect(heldTextAt(held, 'C:\\Mods\\B\\build.json')).toBeUndefined();
    expect(samePath('c:\\Mods\\A', 'C:\\Mods\\A')).toBe(true);
  });
});

describe('where a file names a symbol', () => {
  it('counts lines and characters from the start of the text, across any line ending', () => {
    const text = 'first\r\nsecond\rthird\nthe A.esp';
    const start = text.indexOf('A.esp');

    expect(placeIn('/f.txt', text, start, start + 'A.esp'.length)).toEqual({
      file: '/f.txt', start: { line: 3, character: 4 }, end: { line: 3, character: 9 },
    });
  });
});
