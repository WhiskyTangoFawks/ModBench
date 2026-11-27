import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import type { EntryRef, Mod, ModlistEntry, ModOrderChange, MovePlace, SeparatorsPlace, Separator } from '../../../instanceAdapter';
import { mo2InstanceHolding, type HeldInstance } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const fixtureDir = join(__dirname, '..', '..', '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance');
const defaultModlist = () =>
  readFileSync(join(fixtureDir, 'profiles', 'Default', 'modlist.txt'), 'utf8');

const MODLIST = 'profiles/Default/modlist.txt';

const holding = (text: string): HeldInstance => mo2InstanceHolding({ [MODLIST]: text });

const orderOf = async (text: string): Promise<readonly ModlistEntry[]> => (await holding(text).adapter.modOrder()).mods;

const changing = (text: string, change: ModOrderChange) => holding(text).adapter.changeModOrder('Default', () => [change]);

async function changed(text: string, change: ModOrderChange): Promise<string> {
  const instance = holding(text);
  await instance.adapter.changeModOrder('Default', () => [change]);
  return instance.text(MODLIST);
}

const enabled = (text: string, mod: string, on: boolean): Promise<string> => changed(text, { kind: 'enable', mod, enabled: on });

describe('a mod\'s state set in modlist.txt, every other byte kept', () => {
  it('flips exactly one prefix and leaves every other byte (CRLF, comment, * lines) identical', async () => {
    const input = defaultModlist();
    const out = await enabled(input, 'SKK Fast Start new game (Fallout 4)', false);

    expect(out).toBe(input.replace('+SKK Fast Start new game (Fallout 4)', '-SKK Fast Start new game (Fallout 4)'));
  });

  it('is a no-op when the mod already has the requested state', async () => {
    const input = defaultModlist();
    expect(await enabled(input, 'SKK Fast Start new game (Fallout 4)', true)).toBe(input);
  });

  it('round-trips: disable then re-enable yields the original bytes', async () => {
    const input = defaultModlist();
    const disabled = await enabled(input, 'SKK Fast Start new game (Fallout 4)', false);
    expect(await enabled(disabled, 'SKK Fast Start new game (Fallout 4)', true)).toBe(input);
  });

  it('does not match a separator line as a mod, so toggling a name that exists only as a separator fails', async () => {
    await expect(changing(defaultModlist(), { kind: 'enable', mod: 'Unassigned (Modlist Development)', enabled: false }))
      .rejects.toThrow('Mod not found in modlist: Unassigned (Modlist Development)');
  });

  it('preserves a leading BOM byte-for-byte when editing a later line', async () => {
    expect(await enabled('﻿+First\r\n+Second\r\n', 'Second', false)).toBe('﻿+First\r\n-Second\r\n');
  });
});

describe('the mod order a modlist.txt holds', () => {
  it.each<[string, string, (Mod | Separator)[]]>([
    ['mods and separators in priority order, past comment, * and blank lines', defaultModlist(), [
      { kind: 'mod', name: 'SKK Fast Start new game (Fallout 4)', enabled: true },
      { kind: 'separator', name: 'Unassigned (Modlist Development)', enabled: false },
      { kind: 'mod', name: '[NODELETE] Radfall', enabled: true },
      { kind: 'mod', name: 'Unofficial Fallout 4 Patch', enabled: true },
      { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul', enabled: false },
      { kind: 'mod', name: 'ENBoost - 12k', enabled: true },
      { kind: 'mod', name: 'Harder VATS', enabled: false },
      { kind: 'mod', name: 'Cracked and Smudged Pip-Boy Screen', enabled: true },
    ]],
    ['an enabled separator (+…_separator)', '+ENB_separator\r\n', [{ kind: 'separator', name: 'ENB', enabled: true }]],
    ['no entries for a file of only comment, * and blank lines', '# header\r\n*DLC: Automatron\r\n\r\n   \r\n+\r\n', []],
    ['a line with no prefix as an enabled mod, each name trimmed', 'Bare\r\n+ Padded  \r\n-  Off \r\n', [
      { kind: 'mod', name: 'Bare', enabled: true },
      { kind: 'mod', name: 'Padded', enabled: true },
      { kind: 'mod', name: 'Off', enabled: false },
    ]],
    ['the top-priority mod behind a leading UTF-8 BOM', '﻿+First\r\n+Second\r\n', [
      { kind: 'mod', name: 'First', enabled: true },
      { kind: 'mod', name: 'Second', enabled: true },
    ]],
    ['no false entry for a BOM before a line that is no entry', '﻿# header\r\n', []],
  ])('reads %s', async (_, text, entries) => {
    expect(await orderOf(text)).toEqual(entries);
  });

  it.each([
    ['+Mod\r\n-mod\r\n', false],
    ['-Mod\r\n+mod\r\n-Mod\r\n', true],
    ['+Mod\r\n-Mod\r\n', true],
  ])('gives a name that two lines spell alike in case the state of the last, and a repeat of the same case none: %j', async (text, on) => {
    expect((await orderOf(text))[0]?.enabled).toBe(on);
  });
});

describe('edits on lines MO2 reads', () => {
  it.each([
    ['Bare \r\n+Other\r\n-bare\r\n', false, '-Bare\r\n+Other\r\n-bare\r\n'],
    [' Bare \r\n-bare\r\n', true, ' Bare \r\n+bare\r\n'],
  ])('toggles an unprefixed, padded line and every case-variant line of its name: %j', async (text, on, out) => {
    expect(await enabled(text, 'Bare', on)).toBe(out);
  });

  it('renames an unprefixed line without inventing a prefix', async () => {
    expect(await changed('Bare\r\n', { kind: 'renameMod', from: 'Bare', to: 'New' })).toBe('New\r\n');
  });
});

describe('a separator inserted beside an entry in modlist.txt', () => {
  const mod = (name: string): EntryRef => ({ kind: 'mod', name });
  const separator = (name: string): EntryRef => ({ kind: 'separator', name });
  const H = '# header\r\n';

  it.each([
    ['directly after a mod anchor', '+A\n+B\n', mod('A'), '+A\n+S_separator\n+B\n'],
    ['after the last mod, joining no lines when it is unterminated', '+A', mod('A'), '+A\n+S_separator'],
    ['before the first mod of a separator anchor\'s group, taking none', '+A\n+B\n+X_separator\n+C\n', separator('X'), '+S_separator\n+A\n+B\n+X_separator\n+C\n'],
    ['before the first mod the reading shows in a separator anchor\'s group, a repeated separator line holding no boundary',
      '+A\n+X_separator\n+B\n-x_separator\n+C\n+Y_separator\n', separator('Y'), '+A\n+X_separator\n+S_separator\n+B\n-x_separator\n+C\n+Y_separator\n'],
    ['before an anchor separator with no mods of its own', '+First_separator\n+Second_separator\n+M\n', separator('Second'), '+First_separator\n+S_separator\n+Second_separator\n+M\n'],
    ['before every mod, leaving the header above it, when the anchor is the winning-most separator', `${H}+A\r\n+X_separator\r\n`, separator('X'), `${H}+S_separator\r\n+A\r\n+X_separator\r\n`],
    ['beside the anchor of the kind it is handed, when a mod and a separator share a name', '+Gear_separator\n+Gear\n', mod('Gear'), '+Gear_separator\n+Gear\n+S_separator\n'],
  ])('puts a separator %s', async (_, before, anchor, after) => {
    expect(await changed(before, { kind: 'addSeparator', separator: 'S', anchor })).toBe(after);
  });
});

describe('a separator renamed in modlist.txt', () => {
  it('replaces only the separator name, preserving prefix, suffix, CRLF, and all other bytes', async () => {
    const input = defaultModlist();
    expect(await changed(input, { kind: 'renameSeparator', from: 'Unassigned (Modlist Development)', to: 'Core Mods' }))
      .toBe(input.replace('-Unassigned (Modlist Development)_separator\r\n', '-Core Mods_separator\r\n'));
  });
});

describe('a mod\'s line renamed in modlist.txt', () => {
  it('renames a mod line by its MO2 name, keeping its enabled state, place, CRLF and BOM', async () => {
    expect(await changed('﻿+A\r\n-Old Mod\r\n+B\r\n', { kind: 'renameMod', from: 'Old Mod', to: 'New Mod' })).toBe('﻿+A\r\n-New Mod\r\n+B\r\n');
  });

  it('writes nothing when no line carries the name', async () => {
    expect(await changing('+A\r\n', { kind: 'renameMod', from: 'Gone', to: 'X' })).toEqual({ wrote: false, landed: [] });
  });
});

describe('a separator deleted from modlist.txt', () => {
  it('removes only the separator line; child mods remain, promoted to ungrouped or prior separator', async () => {
    const input = defaultModlist();
    expect(await changed(input, { kind: 'dropSeparator', separator: 'Unassigned (Modlist Development)' }))
      .toBe(input.replace('-Unassigned (Modlist Development)_separator\r\n', ''));
  });
});

describe('a mod removed from modlist.txt', () => {
  it('removes the mod entry line entirely, leaving all other bytes intact', async () => {
    const input = defaultModlist();
    expect(await changed(input, { kind: 'dropMod', mod: '[NODELETE] Radfall' })).toBe(input.replace('+[NODELETE] Radfall\r\n', ''));
  });

  it('does not remove a separator line when given only the separator base name', async () => {
    const input = defaultModlist();
    expect(await changed(input, { kind: 'dropMod', mod: 'Unassigned (Modlist Development)' })).toBe(input);
  });
});

describe('mods moved in modlist.txt', () => {
  const defaultMovedAboveRadfallSeparator = [
    '# This file was automatically generated by Mod Organizer.',
    '-Unassigned (Modlist Development)_separator',
    '+[NODELETE] Radfall',
    '+Unofficial Fallout 4 Patch',
    '+SKK Fast Start new game (Fallout 4)',
    '+Cracked and Smudged Pip-Boy Screen',
    '-Radfall - All-In-One Survival Overhaul_separator',
    '+ENBoost - 12k',
    '-Harder VATS',
    '*DLC: Automatron',
    '*Creation Club: ccBGSFO4044-HellfirePowerArmor',
    '*Unmanaged: ccSBJFO4003-Grenade',
    '',
  ].join('\r\n');

  it.each<[string, string, string[], MovePlace, 'winning' | 'losing', string]>([
    ['mods that already sit there leave the text as it was',
      defaultModlist(), ['[NODELETE] Radfall', 'Unofficial Fallout 4 Patch'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing', defaultModlist()],
    ['at the losing end of a separator, land directly above the separator line, every other line where it was',
      defaultModlist(), ['Cracked and Smudged Pip-Boy Screen', 'SKK Fast Start new game (Fallout 4)'], { kind: 'separator', name: 'Radfall - All-In-One Survival Overhaul' }, 'losing', defaultMovedAboveRadfallSeparator],
    ['at the losing end of the ungrouped mods, land after the last entry line, above the unmanaged lines',
      '+A\r\n+S_separator\r\n+B\r\n*DLC: X\r\n', ['A'], { kind: 'ungrouped' }, 'losing', '+S_separator\r\n+B\r\n+A\r\n*DLC: X\r\n'],
    ['at the losing end of the ungrouped mods, several keep their order among themselves',
      '+A\r\n+B\r\n+S_separator\r\n+C\r\n', ['B', 'A'], { kind: 'ungrouped' }, 'losing', '+S_separator\r\n+C\r\n+A\r\n+B\r\n'],
    ['at the losing end of mod order, land after the last entry line, above the unmanaged lines',
      '+A\r\n+B\r\n*DLC: X\r\n', ['A'], { kind: 'modOrder' }, 'losing', '+B\r\n+A\r\n*DLC: X\r\n'],
    ['at the winning end of mod order, land below a leading comment',
      '# h\r\n+A\r\n+B\r\n', ['B'], { kind: 'modOrder' }, 'winning', '# h\r\n+B\r\n+A\r\n'],
    ['beside a mod on its losing side, land directly below its line',
      '+A\r\n+B\r\n+Sep_separator\r\n+C\r\n', ['C'], { kind: 'mod', name: 'A' }, 'losing', '+A\r\n+C\r\n+B\r\n+Sep_separator\r\n'],
    ['beside a mod on its winning side, land directly above its line',
      '+A\r\n+B\r\n+Sep_separator\r\n+C\r\n', ['C'], { kind: 'mod', name: 'A' }, 'winning', '+C\r\n+A\r\n+B\r\n+Sep_separator\r\n'],
    ['into a separator that holds no mods, become its only mods',
      '+A\r\n+Sep1_separator\r\n+Sep2_separator\r\n+B\r\n', ['B'], { kind: 'separator', name: 'Sep2' }, 'losing', '+A\r\n+Sep1_separator\r\n+B\r\n+Sep2_separator\r\n'],
    ['a disabled mod keeps its prefix',
      '+A\r\n-B\r\n+C\r\n', ['B'], { kind: 'mod', name: 'A' }, 'winning', '-B\r\n+A\r\n+C\r\n'],
    ['a commented line stays where it was among the lines that stay',
      '+A\r\n#note\r\n+B\r\n+C\r\n', ['A'], { kind: 'mod', name: 'C' }, 'losing', '#note\r\n+B\r\n+C\r\n+A\r\n'],
    ['at the winning end of a separator, land directly below the previous separator line',
      '+A\r\n+S1_separator\r\n+B\r\n+S2_separator\r\n+C\r\n+D\r\n', ['D', 'C'], { kind: 'separator', name: 'S2' }, 'winning', '+A\r\n+S1_separator\r\n+C\r\n+D\r\n+B\r\n+S2_separator\r\n'],
    ['at the winning end of the first separator, land at the first entry line, below a leading comment',
      '# h\r\n+A\r\n+S1_separator\r\n+B\r\n', ['B'], { kind: 'separator', name: 'S1' }, 'winning', '# h\r\n+B\r\n+A\r\n+S1_separator\r\n'],
    ['at the winning end of the ungrouped mods, land directly below the last separator line',
      '+A\r\n+S1_separator\r\n+B\r\n+C\r\n', ['A'], { kind: 'ungrouped' }, 'winning', '+S1_separator\r\n+A\r\n+B\r\n+C\r\n'],
    ['at the winning end with no separator at all, land at the first entry line',
      '# h\r\n+A\r\n+B\r\n+C\r\n', ['C'], { kind: 'ungrouped' }, 'winning', '# h\r\n+C\r\n+A\r\n+B\r\n'],
  ])('%s', async (_what, text, mods, place, end, expected) => {
    expect(await changed(text, { kind: 'moveMods', mods, place, end })).toBe(expected);
  });

  it.each<[string, string, string[], MovePlace, string]>([
    ['a mod that is absent', '+A\r\n+B\r\n', ['A'], { kind: 'mod', name: 'No Such Mod' }, 'No Such Mod'],
    ['a separator that is absent', '+A\r\n+B\r\n', ['A'], { kind: 'separator', name: 'No Such Sep' }, 'No Such Sep'],
  ])('throws naming %s', async (_what, text, mods, place, named) => {
    await expect(changing(text, { kind: 'moveMods', mods, place, end: 'losing' })).rejects.toThrow(named);
  });

  it('preserves every byte it does not move: the comment header, the * lines and CRLF', async () => {
    const input = defaultModlist();

    const out = await changed(input, { kind: 'moveMods', mods: ['Cracked and Smudged Pip-Boy Screen'], place: { kind: 'modOrder' }, end: 'winning' });

    expect(out).toBe(input
      .replace('+Cracked and Smudged Pip-Boy Screen\r\n', '')
      .replace('Mod Organizer.\r\n', 'Mod Organizer.\r\n+Cracked and Smudged Pip-Boy Screen\r\n'));
  });
});

describe('separators moved in modlist.txt', () => {
  const header = '# h\r\n';
  const threeSeparators = `${header}+A\r\n+S1_separator\r\n+B\r\n+S2_separator\r\n+C\r\n+S3_separator\r\n+D\r\n`;
  const twoSeparators = `${header}+A\r\n+S1_separator\r\n+B\r\n+S2_separator\r\n+C\r\n`;

  it.each<[string, string, string[], SeparatorsPlace, 'winning' | 'losing', string]>([
    ['a separator that already sits there leaves the text as it was',
      defaultModlist(), ['Radfall - All-In-One Survival Overhaul'], { kind: 'separator', name: 'Unassigned (Modlist Development)' }, 'losing', defaultModlist()],
    ['on the losing side, each block lands in file order directly below the target line, a leading comment staying',
      threeSeparators, ['S3', 'S1'], { kind: 'separator', name: 'S2' }, 'losing', `${header}+B\r\n+S2_separator\r\n+A\r\n+S1_separator\r\n+C\r\n+S3_separator\r\n+D\r\n`],
    ['a separator that holds no mods moves as its line alone',
      '+A\r\n+S1_separator\r\n+S2_separator\r\n+C\r\n+S3_separator\r\n+D\r\n', ['S2'], { kind: 'separator', name: 'S3' }, 'losing', '+A\r\n+S1_separator\r\n+C\r\n+S3_separator\r\n+S2_separator\r\n+D\r\n'],
    ['on the winning side, each block lands directly above the target\'s own block',
      threeSeparators, ['S3'], { kind: 'separator', name: 'S2' }, 'winning', `${header}+A\r\n+S1_separator\r\n+C\r\n+S3_separator\r\n+B\r\n+S2_separator\r\n+D\r\n`],
    ['disabled separators and mods keep their prefixes',
      '-A\r\n-S1_separator\r\n+B\r\n+S2_separator\r\n', ['S1'], { kind: 'separator', name: 'S2' }, 'losing', '+B\r\n+S2_separator\r\n-A\r\n-S1_separator\r\n'],
    ['a commented-out separator line is never taken for a live one: it rides in the block it sits in',
      '+PrevSep_separator\r\n+B\r\n#fake_separator\r\n+C\r\n+TargetSep_separator\r\n+D\r\n', ['TargetSep'], { kind: 'modOrder' }, 'winning', '+B\r\n#fake_separator\r\n+C\r\n+TargetSep_separator\r\n+PrevSep_separator\r\n+D\r\n'],
    ['at the losing end of mod order, land on the winning side of the ungrouped mods, taking none',
      twoSeparators, ['S1'], { kind: 'modOrder' }, 'losing', `${header}+B\r\n+S2_separator\r\n+A\r\n+S1_separator\r\n+C\r\n`],
    ['at the winning end of mod order, land below a leading comment',
      twoSeparators, ['S2'], { kind: 'modOrder' }, 'winning', `${header}+B\r\n+S2_separator\r\n+A\r\n+S1_separator\r\n+C\r\n`],
    ['a repeated separator line is no boundary: the block holds the mods the reading shows in it',
      '+A\n+X_separator\n+B\n-x_separator\n+C\n+Y_separator\n', ['Y'], { kind: 'separator', name: 'X' }, 'winning', '+B\n-x_separator\n+C\n+Y_separator\n+A\n+X_separator\n'],
    ['on the winning side of the first separator, land below a leading comment',
      `${header}+A\r\n+S1_separator\r\n+B\r\n+S2_separator\r\n`, ['S2'], { kind: 'separator', name: 'S1' }, 'winning', `${header}+B\r\n+S2_separator\r\n+A\r\n+S1_separator\r\n`],
  ])('%s', async (_what, text, separators, place, end, expected) => {
    expect(await changed(text, { kind: 'moveSeparators', separators, place, end })).toBe(expected);
  });

  it('throws naming a target that is absent', async () => {
    await expect(changing(defaultModlist(), { kind: 'moveSeparators', separators: ['Unassigned (Modlist Development)'], place: { kind: 'separator', name: 'No Such Sep' }, end: 'losing' }))
      .rejects.toThrow(/No Such Sep/);
  });

  it('preserves every byte it does not move: the comment header, the * lines and CRLF', async () => {
    const input = defaultModlist();

    const out = await changed(input, { kind: 'moveSeparators', separators: ['Unassigned (Modlist Development)'], place: { kind: 'modOrder' }, end: 'losing' });

    expect(out.startsWith('# This file was automatically generated by Mod Organizer.\r\n+[NODELETE] Radfall\r\n')).toBe(true);
    expect(out.endsWith('*Unmanaged: ccSBJFO4003-Grenade\r\n')).toBe(true);
    expect(out).toHaveLength(input.length);
  });
});

describe('a mod added disabled at the winning end, as the first entry', () => {
  it('inserts a disabled line as the first entry, below the leading comment, and preserves every other byte', async () => {
    const input = defaultModlist();
    expect(await changed(input, { kind: 'addAtWinningEnd', entry: { kind: 'mod', name: 'My New Mod' } }))
      .toBe(input.replace('Mod Organizer.\r\n', 'Mod Organizer.\r\n-My New Mod\r\n'));
  });

  it.each([
    ['in the file\'s CRLF', '+A\r\n+B\r\n', 'C', '-C\r\n+A\r\n+B\r\n'],
    ['in the file\'s LF', '+A\n+B\n', 'C', '-C\n+A\n+B\n'],
    ['into an empty file', '', 'C', '-C\n'],
    ['keeping an unterminated last line unterminated', '# header\r\n+A\r\n*DLC: Foo', 'New', '# header\r\n-New\r\n+A\r\n*DLC: Foo'],
  ])('inserts before the first entry %s', async (_, input, name, out) => {
    expect(await changed(input, { kind: 'addAtWinningEnd', entry: { kind: 'mod', name } })).toBe(out);
  });
});
