import { describe, it, expect, vi } from 'vitest';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import { expectKind } from '../../../../test/expectKind';
import { mo2InstanceHolding } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const lineOf = (key: string, value: string | undefined): string => (value === undefined ? '' : `${key}=${value}\r\n`);

async function updateAvailable(version: string | undefined, newest: string | undefined): Promise<boolean | undefined> {
  const { adapter } = mo2InstanceHolding({
    'profiles/Default/modlist.txt': '+M\r\n',
    'mods/M/meta.ini': `[General]\r\n${lineOf('version', version)}${lineOf('newestVersion', newest)}`,
  });
  return (await adapter.reading()).mods.find((entry) => entry.kind === 'mod')?.updateAvailable;
}

async function written(version: string): Promise<string | undefined> {
  const { adapter } = mo2InstanceHolding({ 'downloads/Release.7z': 'bytes' });
  await adapter.writeNexusFileInfo('Release.7z', { game: 'fallout4', modID: '1', version });
  return expectKind((await adapter.reading()).downloadedFiles, 'listed').files?.[0]?.meta?.version;
}

describe('whether a newer version is an update, in MO2 VersionInfo\'s order (uibase versioninfo.cpp)', () => {
  it.each([
    ['older', '1.0', '1.1', true],
    ['the same', '1.1', '1.1', false],
    ['newer', '1.2', '1.1', false],
    ['numeric, not lexical', '1.9', '1.10', true],
    ['a shorter version is its zero-padded form', '1.1', '1.1.0.1', true],
    ['beta before final', '1.0.0.0b', '1.0.0.0', true],
    ['alpha before final', '1.0.0.0a', '1.0.0.0', true],
    ['rc before final', '1.0.0.0rc', '1.0.0.0', true],
    ['prealpha reads as alpha with the rest "pre"', '1.0 prealpha', '1.0a', false],
    ['alpha before beta', '1.0a', '1.0b', true],
    ['beta before rc', '1.0beta', '1.0rc', true],
    ['rc before final, spelled out', '1.0rc1', '1.0', true],
    ['final is not before rc', '1.0', '1.0rc', false],
    ['the rest, numerically', '1.0.0.0rc2', '1.0.0.0rc10', true],
    ['the rest, lexically', '1.0x', '1.0y', true],
    ['decimal against regular', 'f1.05', '1.1.0.0', true],
    ['decimal compared as a float', 'f1.05', 'f1.5', true],
    ['decimal within tolerance falls to the rest', 'f1.05', 'f1.05', false],
    ['a leading zero in the fraction hints decimal', '1.05', '1.1', true],
    ['date before regular', 'd2024.3.26.0', '1.2.0.0', true],
    ['regular is not before date', '1.0.0.0', 'd2024.3.26.0', false],
    ['dates in order', 'd2024.3.26.0', 'd2024.4.1.0', true],
    ['a date before 1900 is regular', 'd1.0', 'd1.1', true],
    ['a leading v is dropped', 'v1.2', '1.3.0.0', true],
    ['a leading V is dropped', 'V1.4', '1.3.0.0', false],
    ['n scheme orders as regular', 'n1.0.1.0', 'n1.0.2.0', true],
    ['final is 1', 'final', '2.0', true],
    ['no version is before any newest version', undefined, '1.0', true],
    ['a blank version is before any newest version', '', '1.0', true],
    ['no version is before a newest version of zero', undefined, '0', true],
    ['a literal version is zero, so before any newest version', 'unknown', '1.0', true],
    ['no newest version shows nothing', '1.0', undefined, false],
    ['a blank newest version shows nothing', '1.0', '', false],
    ['neither', undefined, undefined, false],
  ])('%s: %s to %s is %s', async (_, version, newest, expected) => {
    expect(await updateAvailable(version, newest)).toBe(expected);
  });
});

describe('a version in its canonical form, as VersionInfo::canonicalString writes it (uibase versioninfo.cpp)', () => {
  it.each([
    ['1.2', '1.2.0.0'],
    ['v1.2.3', '1.2.3.0'],
    ['1.2.3.4', '1.2.3.4'],
    ['1.0b', '1.0.0.0b'],
    ['1.0 beta', '1.0.0.0b'],
    ['1.0 rc', '1.0.0.0rc'],
    ['1.0 prealpha', '1.0.0.0apre'],
    ['f1.05', 'f1.05'],
    ['1.05', 'f1.05'],
    ['n1.2', 'n1.2.0.0'],
    ['d2020.1.2', 'd2020.1.2.0'],
    ['1.2 extra', '1.2.0.0extra'],
    ['final', '1.0.0.0'],
    ['', undefined],
  ])('writes %j as %j', async (version, canonical) => {
    expect(await written(version)).toBe(canonical);
  });
});
