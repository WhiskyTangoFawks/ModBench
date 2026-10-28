import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePlugins, pluginsTextOf, setPluginEnabledInText, movePluginsInText, appendPluginInText, removePluginFromText, renamePluginInText,
} from '../pluginsText';
import type { PluginEntry } from '../pluginsText';

const fixtureDir = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance');
const defaultPlugins = () =>
  readFileSync(join(fixtureDir, 'profiles', 'Default', 'plugins.txt'), 'utf8');

const names = (text: string) => parsePlugins(text).map((e) => e.name);

describe('parsePlugins', () => {
  it('surfaces enabled/disabled entries in order, ignoring comment/blank lines', () => {
    const entries = parsePlugins('# header\r\n*Foo.esp\r\nBar.esp\r\n\r\n*Baz.esl\r\n');
    expect(entries).toEqual([
      { name: 'Foo.esp', enabled: true },
      { name: 'Bar.esp', enabled: false },
      { name: 'Baz.esl', enabled: true },
    ] satisfies PluginEntry[]);
  });

  it('parses the committed fixture (comment header + two enabled entries)', () => {
    expect(parsePlugins(defaultPlugins())).toEqual([
      { name: 'Unofficial Fallout 4 Patch.esp', enabled: true },
      { name: 'ccSBJFO4003-Grenade.esl', enabled: true },
    ] satisfies PluginEntry[]);
  });

  it.each<[string, string, PluginEntry[]]>([
    ['a leading UTF-8 BOM is stripped, so the top plugin is not silently dropped', '﻿*First.esp\r\nSecond.esp\r\n',
      [{ name: 'First.esp', enabled: true }, { name: 'Second.esp', enabled: false }]],
    ['a whitespace-only line is blank, not a phantom entry named for its spaces', '﻿# header\r\n*Foo.esp\r\n\r\n   \r\nBar.esp\r\n',
      [{ name: 'Foo.esp', enabled: true }, { name: 'Bar.esp', enabled: false }]],
    ['leading whitespace before the marker neither hides it nor leaks into the name', ' *Foo.esp\r\n', [{ name: 'Foo.esp', enabled: true }]],
    ['leading whitespace with no marker parses as disabled, the name without the padding', ' Foo.esp\r\n', [{ name: 'Foo.esp', enabled: false }]],
    ['trailing whitespace does not leak into the name', 'Foo.esp \r\n', [{ name: 'Foo.esp', enabled: false }]],
    ['a comment line with leading whitespace is still a comment', '  # header\r\n*Foo.esp\r\n', [{ name: 'Foo.esp', enabled: true }]],
  ])('%s', (_case, text, entries) => {
    expect(parsePlugins(text)).toEqual(entries);
  });
});

describe('setPluginEnabledInText — byte-faithful surgical edit', () => {
  it('removes exactly one * and leaves every other byte (CRLF, comment) identical', () => {
    const input = defaultPlugins();
    const out = setPluginEnabledInText(input, 'Unofficial Fallout 4 Patch.esp', false);
    expect(out).toBe(input.replace('*Unofficial Fallout 4 Patch.esp', 'Unofficial Fallout 4 Patch.esp'));
  });

  it('is a no-op when the plugin already has the requested state', () => {
    const input = defaultPlugins();
    expect(setPluginEnabledInText(input, 'ccSBJFO4003-Grenade.esl', true)).toBe(input);
  });

  it('adds a * when enabling a disabled plugin, preserving comment/blank lines', () => {
    const input = '# header\r\nFoo.esp\r\n\r\nBar.esp\r\n';
    const out = setPluginEnabledInText(input, 'Foo.esp', true);
    expect(out).toBe('# header\r\n*Foo.esp\r\n\r\nBar.esp\r\n');
  });

  it('toggling a plugin name with no entry line, which the tree as a pure read of plugins.txt never shows, is a no-op in both directions, byte-identical', () => {
    const input = defaultPlugins();
    expect(setPluginEnabledInText(input, 'No Such.esp', false)).toBe(input);
    expect(setPluginEnabledInText(input, 'No Such.esp', true)).toBe(input);
  });

  it('preserves a leading BOM when toggling the first line', () => {
    const out = setPluginEnabledInText('\uFEFF*First.esp\r\n*Second.esp\r\n', 'First.esp', false);
    expect(out).toBe('\uFEFFFirst.esp\r\n*Second.esp\r\n');
  });

  it('locates a hand-padded line by its trimmed name and flips only the marker byte, leaving the padding and every other line untouched', () => {
    const input = '*A.esp\r\n *Foo.esp\r\nB.esp\r\n';
    const out = setPluginEnabledInText(input, 'Foo.esp', false);
    expect(out).toBe('*A.esp\r\n Foo.esp\r\nB.esp\r\n');
  });

  it('enabling a hand-padded disabled line inserts the marker after the padding, not before it', () => {
    const input = '*A.esp\r\n Foo.esp\r\nB.esp\r\n';
    const out = setPluginEnabledInText(input, 'Foo.esp', true);
    expect(out).toBe('*A.esp\r\n *Foo.esp\r\nB.esp\r\n');
  });

  it('round-trips: disable then re-enable yields the original bytes', () => {
    const input = defaultPlugins();
    const disabled = setPluginEnabledInText(input, 'Unofficial Fallout 4 Patch.esp', false);
    expect(setPluginEnabledInText(disabled, 'Unofficial Fallout 4 Patch.esp', true)).toBe(input);
  });
});

describe('appendPluginInText — byte-faithful append of a disk-discovered plugin, disabled as discovery is not user intent to enable, at the bottom, the winning end of the plugin override order', () => {
  it('appends a disabled entry line after the last existing entry, preserving everything before it', () => {
    const input = defaultPlugins();
    const out = appendPluginInText(input, 'NewPlugin.esp');
    expect(out).toBe(input + 'NewPlugin.esp\r\n');
  });

  it('appends to an empty file', () => {
    expect(appendPluginInText('', 'Only.esp')).toBe('Only.esp\n');
  });

  it('preserves a trailing comment/blank line by landing before it, not after', () => {
    const input = '*A.esp\r\nB.esp\r\n# trailing comment\r\n';
    const out = appendPluginInText(input, 'New.esp');
    expect(out).toBe('*A.esp\r\nB.esp\r\nNew.esp\r\n# trailing comment\r\n');
  });

  it('keeps the file\'s EOL style and its unterminated last line', () => {
    const input = '*A.esp\r\nB.esp';
    const out = appendPluginInText(input, 'New.esp');
    expect(out).toBe('*A.esp\r\nB.esp\r\nNew.esp');
  });

  it('throws when the name already exists (never a silent duplicate line)', () => {
    const input = defaultPlugins();
    expect(() => appendPluginInText(input, 'Unofficial Fallout 4 Patch.esp')).toThrow(/Unofficial Fallout 4 Patch\.esp/);
  });
});

describe('removePluginFromText — byte-faithful line removal', () => {
  it('removes exactly the named entry line, leaving every other byte (CRLF, comment, blank) identical', () => {
    const input = '# header\r\n*A.esp\r\n\r\nB.esp\r\n*C.esp\r\n';
    expect(removePluginFromText(input, 'B.esp')).toBe('# header\r\n*A.esp\r\n\r\n*C.esp\r\n');
  });

  it('removes an enabled entry by its name, not its marker', () => {
    expect(removePluginFromText('*A.esp\r\n*B.esp\r\n', 'A.esp')).toBe('*B.esp\r\n');
  });

  it('throws when the name has no entry line', () => {
    expect(() => removePluginFromText('*A.esp\r\n', 'Nope.esp')).toThrow(/Nope\.esp/);
  });
});

describe('renamePluginInText — byte-faithful rename of one line, in place', () => {
  it('names the line anew where it stands, keeping its enabled mark and every other byte', () => {
    const input = '# header\r\n*A.esp\r\n\r\nB.esp\r\n*C.esp\r\n';
    expect(renamePluginInText(input, 'A.esp', 'Z.esp')).toBe('# header\r\n*Z.esp\r\n\r\nB.esp\r\n*C.esp\r\n');
    expect(renamePluginInText(input, 'B.esp', 'Z.esp')).toBe('# header\r\n*A.esp\r\n\r\nZ.esp\r\n*C.esp\r\n');
  });

  it('keeps a hand-padded line\'s padding', () => {
    expect(renamePluginInText('  *Second.esp  ', 'Second.esp', 'Third.esp')).toBe('  *Third.esp  ');
  });

  it('leaves a comment that holds the name alone', () => {
    expect(renamePluginInText('# A.esp\n*A.esp\n', 'A.esp', 'B.esp')).toBe('# A.esp\n*B.esp\n');
  });

  it('throws when the name has no entry line', () => {
    expect(() => renamePluginInText('*A.esp\r\n', 'Nope.esp', 'B.esp')).toThrow(/Nope\.esp/);
  });
});

describe('movePluginsInText — byte-faithful reorder', () => {
  const sample = '# header\r\n*A.esp\r\nB.esp\r\n*C.esp\r\nD.esp\r\n';

  it('moves a plugin below an unterminated last line without joining the two', () => {
    expect(movePluginsInText('A.esp\nB.esp', ['A.esp'], 1)).toBe('B.esp\nA.esp');
  });

  it('moves a plugin the file repeats with its repeat, the moved line still the first', () => {
    const out = movePluginsInText('*A.esp\nB.esp\nC.esp\nA.esp\n', ['A.esp'], 1);

    expect(out).toBe('B.esp\n*A.esp\nA.esp\nC.esp\n');
  });

  it('lands at the record index of the entries the reading shows: a repeated line ahead of the target is not one', () => {
    const out = movePluginsInText('A.esp\nB.esp\nA.esp\nC.esp\nD.esp\n', ['D.esp'], 3);

    expect(names(out)).toEqual(['A.esp', 'B.esp', 'A.esp', 'C.esp', 'D.esp']);
  });

  it('keeps the enabled state of a plugin the file repeats when it moves past its repeat', () => {
    const out = movePluginsInText('*A.esp\nB.esp\nA.esp\nC.esp\n', ['A.esp'], 1);

    expect(parsePlugins(out).find(({ name }) => name === 'A.esp')?.enabled).toBe(true);
  });

  it('moves a repeat spelled with other case along with its plugin', () => {
    const out = movePluginsInText('*A.esp\nB.esp\na.ESP\nC.esp\n', ['A.esp'], 1);

    expect(out).toBe('B.esp\n*A.esp\na.ESP\nC.esp\n');
  });

  it('moves a single plugin to the top (index 0), keeping the comment header first', () => {
    const out = movePluginsInText(sample, ['C.esp'], 0);
    expect(names(out)).toEqual(['C.esp', 'A.esp', 'B.esp', 'D.esp']);
    expect(out.startsWith('# header\r\n')).toBe(true);
    expect(out.length).toBe(sample.length);
  });

  it('moves a contiguous multi-selection as a block, preserving relative order', () => {
    const out = movePluginsInText(sample, ['B.esp', 'C.esp'], 3);
    expect(names(out)).toEqual(['A.esp', 'D.esp', 'B.esp', 'C.esp']);
  });

  it('moves a non-contiguous selection, ordering by source position not argument order', () => {
    const out = movePluginsInText(sample, ['D.esp', 'A.esp'], 1);
    expect(names(out)).toEqual(['B.esp', 'A.esp', 'D.esp', 'C.esp']);
  });

  it('throws when any requested plugin is absent', () => {
    expect(() => movePluginsInText(sample, ['A.esp', 'No Such.esp'], 0)).toThrow(/No Such\.esp/);
  });

  it('keeps comment/blank lines at their absolute position (only entries move)', () => {
    const text = '# top\r\n*A.esp\r\n\r\n# mid\r\nB.esp\r\nC.esp\r\n';
    const out = movePluginsInText(text, ['C.esp'], 0);
    expect(names(out)).toEqual(['C.esp', 'A.esp', 'B.esp']);
    expect(out.startsWith('# top\r\n')).toBe(true);
    expect(out).toContain('\r\n\r\n# mid\r\n');
  });

  it('re-lands correctly when moving the only entry leaves the file with zero entries', () => {
    const out = movePluginsInText('# only comment\r\n*OnlyPlugin.esp\r\n', ['OnlyPlugin.esp'], 0);
    expect(out).toBe('# only comment\r\n*OnlyPlugin.esp\r\n');
  });

  it.each([
    ['to the end', sample, 'A.esp', '# header\r\nB.esp\r\n*C.esp\r\nD.esp\r\n*A.esp\r\n'],
    ['to land before a trailing comment, not past it', '*A.esp\r\nB.esp\r\n# trailing comment\r\n', 'B.esp', '*A.esp\r\nB.esp\r\n# trailing comment\r\n'],
  ])('clamps an out-of-range index %s', (_case, text, moved, expected) => {
    expect(movePluginsInText(text, [moved], 99)).toBe(expected);
  });
});

describe('pluginsTextOf', () => {
  it('writes each entry on a CRLF-ended line, enabled ones marked, and parsePlugins reads it back', () => {
    const entries = [{ name: 'Foo.esp', enabled: true }, { name: 'Bar.esp', enabled: false }];

    const text = pluginsTextOf(entries);

    expect([text, parsePlugins(text)]).toEqual(['*Foo.esp\r\nBar.esp\r\n', entries]);
  });
});
