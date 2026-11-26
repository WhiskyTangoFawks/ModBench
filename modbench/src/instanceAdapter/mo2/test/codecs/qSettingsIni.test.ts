import { describe, it, expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { fakeVscodeModule } from '../../../../test/mo2/fakeVscodeWatcher';
import type { ModMetadata } from '../../../instanceAdapter';
import { mo2InstanceHolding, type HeldInstance } from '../../../test/instanceOnDisk';

vi.mock('vscode', () => fakeVscodeModule());

const META = 'mods/M/meta.ini';
const trash = (path: string): Promise<void> => rm(path);

const modHolding = (meta: string): HeldInstance => mo2InstanceHolding({ 'profiles/Default/modlist.txt': '+M\r\n', [META]: meta });

async function versionRead(meta: string): Promise<string | undefined> {
  return (await modHolding(meta).adapter.reading()).mods.find((entry) => entry.kind === 'mod')?.version;
}

async function metaWritten(meta: string, metadata: ModMetadata): Promise<string> {
  const { adapter, text } = modHolding(meta);
  await adapter.writeModMetadata('M', metadata, trash);
  return text(META);
}

async function writtenAndRead(version: string): Promise<{ written: string; read: string | undefined }> {
  const { adapter, text } = modHolding('[General]\n');
  await adapter.writeModMetadata('M', { version }, trash);
  return { written: await text(META), read: (await adapter.reading()).mods.find((entry) => entry.kind === 'mod')?.version };
}

describe('a value read from a QSettings INI, a mod\'s meta.ini version', () => {
  it.each([
    ['reads the key in the named section, not the same key in another', '[A]\r\nversion=wrong\r\n[General]\r\nversion=right\r\n', 'right'],
    ['is undefined when the section lacks the key', '[A]\r\nversion=1\r\n[General]\r\n', undefined],
    ['is undefined when the file lacks the section', '[A]\r\nversion=1\r\n', undefined],
    ['trims padding around the key and the value', '[General]\r\n version = v \r\n', 'v'],
    ['ignores a line with no "=", whose whole text would otherwise pass for a key', '[General]\r\nversion\r\nversion=1\r\n', '1'],
  ])('%s', async (_, meta, version) => {
    expect(await versionRead(meta)).toBe(version);
  });
});

describe('keys above the first header', () => {
  it('read as [General], as QSettings does', async () => {
    expect(await versionRead('version=1\r\n[A]\r\nversion=2\r\n')).toBe('1');
  });

  it('are set in place as [General]', async () => {
    expect(await metaWritten('version=1\r\n[A]\r\nversion=2\r\n', { version: '9' })).toBe('version=9\r\n[A]\r\nversion=2\r\n');
  });
});

describe('a repeated key', () => {
  it('reads and sets its first line', async () => {
    expect([await versionRead('[General]\nversion=1\nversion=2\n'), await metaWritten('[General]\nversion=1\nversion=2\n', { version: '9' })])
      .toEqual(['1', '[General]\nversion=9\nversion=2\n']);
  });
});

describe('decoded values', () => {
  it.each([
    ['unwraps @ByteArray and un-escapes inside it, as Qt writes a path there', '@ByteArray(C:\\\\Mod\\\\x)', 'C:\\Mod\\x'],
    ['un-escapes doubled backslashes', 'C:\\\\Games', 'C:\\Games'],
    ['strips the quote wrapper and un-escapes', '"C:\\\\Games;New"', 'C:\\Games;New'],
    ['drops an unknown escape with its character, as Qt does', 'C:\\Games', 'C:ames'],
    ['reads the named control escapes', 'a\\ab\\bc\\fd\\ve', 'a\x07b\x08c\x0cd\x0be'],
    ['reads a hex escape of any length as one UTF-16 unit, as Qt5 wrote', 'caf\\xe9 \\x20ac', 'caf\u00e9 \u20ac'],
    ['reads an octal escape', 'a\\0b\\101', 'a\0bA'],
    ['reads a leading @@ as one @', '@@Variant(x)', '@Variant(x)'],
    ['reads a unit above 0xFF in a @ByteArray as ?, as toLatin1 does', '@ByteArray(a\\x20acz)', 'a?z'],
    ['reads the UTF-8 bytes of a @ByteArray as text', '@ByteArray(caf\\xc3\\xa9)', 'caf\u00e9'],
  ])('%s', async (_name, raw, expected) => {
    expect(await versionRead(`[General]\nversion=${raw}\n`)).toBe(expected);
  });
});

describe('values written to a QSettings INI, read back as written', () => {
  it.each([
    ['a comma', 'a,b'],
    ['a backslash', 'C:\\Mod\\x'],
    ['a quote', 'say "hi"'],
    ['a semicolon and an equals sign', 'a;b=c'],
    ['leading and trailing spaces', ' padded '],
    ['a newline', 'a\nb'],
    ['plain text', 'My Profile'],
  ])('read back as written: %s', async (_name, value) => {
    expect((await writtenAndRead(value)).read).toBe(value);
  });

  it('quote a comma, as Qt writes category="-1,"', async () => {
    expect((await writtenAndRead('-1,')).written).toBe('[General]\nversion="-1,"\n');
  });

  it('leave plain text bare', async () => {
    expect((await writtenAndRead('My Profile')).written).toBe('[General]\nversion=My Profile\n');
  });
});

describe('a value set in a QSettings INI', () => {
  it.each([
    ['replaces the key in its section only', '[A]\r\nversion=1\r\n[General]\r\nversion=2\r\n', { version: '9' }, '[A]\r\nversion=1\r\n[General]\r\nversion=9\r\n'],
    ['adds an absent key right after its section header', '[General]\r\nx=1\r\n[B]\r\n', { version: '9' }, '[General]\r\nversion=9\r\nx=1\r\n[B]\r\n'],
    ['adds an absent section ahead of everything', '[B]\r\nx=1\r\n', { version: '9' }, '[General]\r\nversion=9\r\n[B]\r\nx=1\r\n'],
    ['writes an empty value as an empty key rather than deleting it', '[General]\nversion=1\n', { version: '' }, '[General]\nversion=\n'],
    ['deletes the key when the value is undefined', '[General]\nmodid=5\nx=2\n', { installationFile: { name: 'New.7z' } }, '[General]\ninstallationFile=New.7z\nx=2\n'],
    ['keeps every other byte of an unchanged file, BOM included',
      '\uFEFF[General]\r\n; note\r\nversion=1\r\n\r\n[B]\r\nx=@ByteArray(a\\\\b)\r\n', { version: '2' }, '\uFEFF[General]\r\n; note\r\nversion=2\r\n\r\n[B]\r\nx=@ByteArray(a\\\\b)\r\n'],
  ])('%s', async (_, meta, metadata, written) => {
    expect(await metaWritten(meta, metadata)).toBe(written);
  });
});

describe('a section replaced whole in a QSettings INI', () => {
  it('removes the section when no lines remain', async () => {
    expect(await metaWritten('[General]\nmodid=5\n[installedFiles]\n1\\modid=5\n1\\fileid=6\nsize=1\n[B]\nz=3\n', { installationFile: { name: 'New.7z' } }))
      .toBe('[General]\ninstallationFile=New.7z\n[B]\nz=3\n');
  });
});

describe('Qt escapes written', () => {
  it.each([
    ['a control character as \\x with the next hex digit escaped too', 'a\x015', 'a\\x1\\x35'],
    ['a NUL as \\0', '\0', '\\0'],
    ['a named control', 'a\nb\tc', 'a\\nb\\tc'],
    ['a leading @ doubled', '@x', '@@x'],
    ['non-ASCII as UTF-8', 'caf\u00e9', 'caf\u00e9'],
  ])('%s', async (_name, value, raw) => {
    expect(await writtenAndRead(value)).toEqual({ written: `[General]\nversion=${raw}\n`, read: value });
  });
});

describe('a value set as a byte array in a QSettings INI, the selected profile in ModOrganizer.ini', () => {
  const selected = async (profile: string) => {
    const { adapter, text } = mo2InstanceHolding({ 'ModOrganizer.ini': '[General]\ngameName=Fallout 4\nselected_profile=Default\n' });
    await adapter.selectProfile(profile);
    return { written: await text('ModOrganizer.ini'), read: await adapter.activeProfile() };
  };

  it('escapes a hex digit after an escaped byte, as Qt does', async () => {
    expect((await selected('Pröfil')).written).toBe('[General]\ngameName=Fallout 4\nselected_profile=@ByteArray(Pr\\xc3\\xb6\\x66il)\n');
  });

  it('writes the UTF-8 bytes at or above 0x7F as \\xNN, as Qt does for a QByteArray', async () => {
    expect((await selected('caf\u00e9')).written).toBe('[General]\ngameName=Fallout 4\nselected_profile=@ByteArray(caf\\xc3\\xa9)\n');
  });

  it('reads back as written', async () => {
    expect((await selected('Pr\u00f6fil, \\x "q"')).read).toBe('Pr\u00f6fil, \\x "q"');
  });
});
