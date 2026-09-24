import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readDownloadDirectory, readGameName, readGamePath, readSelectedProfile, setSelectedProfileInText,
} from '../modOrganizerIni';

const iniPath = join(__dirname, '..', '..', 'test', 'mo2', 'fixtures', 'mo2-instance', 'ModOrganizer.ini');
const ini = () => readFileSync(iniPath, 'utf8');

describe('readSelectedProfile', () => {
  it('unwraps an @ByteArray(...) value', () => {
    expect(readSelectedProfile(ini())).toBe('Default');
  });

  it('reads a plain (non-@ByteArray) value', () => {
    expect(readSelectedProfile('[General]\r\nselected_profile=My Profile\r\n')).toBe('My Profile');
  });

  it('throws a message naming the missing key when the key is absent', () => {
    expect(() => readSelectedProfile('[General]\r\ngameName=Fallout 4\r\n')).toThrow(
      /missing selected_profile/,
    );
  });

  it('does not spuriously match a key-like line lacking "="', () => {
    // The decoy is chosen so that a slice(0, -1) off the missing "=" would land on
    // exactly "selected_profile", ahead of the real line.
    const text = '[General]\r\nselected_profileX\r\nselected_profile=Real Value\r\n';
    expect(readSelectedProfile(text)).toBe('Real Value');
  });
});

describe('readGameName', () => {
  it('throws a message naming the missing key when gameName is absent', () => {
    expect(() => readGameName('[General]\r\nselected_profile=Default\r\n')).toThrow(/missing gameName/);
  });
});

describe('readGamePath', () => {
  it('unwraps an @ByteArray(...) value from the fixture', () => {
    expect(readGamePath(ini())).toBe(String.raw`Z:\\\\path\\to\\Stock Game Folder`);
  });

  it('reads a plain (non-@ByteArray) value', () => {
    const text = '[General]\r\ngamePath=' + String.raw`C:\Games\Fallout4` + '\r\n';
    expect(readGamePath(text)).toBe(String.raw`C:\Games\Fallout4`);
  });

  it('throws a message naming the missing key when the key is absent', () => {
    expect(() => readGamePath('[General]\r\ngameName=Fallout 4\r\n')).toThrow(/missing gamePath/);
  });
});

describe('readDownloadDirectory', () => {
  it('answers undefined when the key is absent, so MO2\'s own default applies', () => {
    expect(readDownloadDirectory(ini())).toBeUndefined();
  });

  // MO2 writes `download_directory` as a plain QString (settings.cpp:1683), never @ByteArray —
  // unlike gamePath. Qt's INI writer escapes a plain string's own backslashes, doubling each one.
  it('un-escapes the doubled backslashes MO2/Qt actually writes for a plain Windows path', () => {
    const onDisk = String.raw`download_directory=C:\\Games\\MO2\\downloads`; // Qt's own escaping
    expect(readDownloadDirectory(`[Settings]\r\n${onDisk}\r\n`)).toBe(String.raw`C:\Games\MO2\downloads`);
  });

  it('un-escapes the doubled backslashes in a Wine Z:-drive path the same way', () => {
    const onDisk = String.raw`download_directory=Z:\\home\\x`;
    expect(readDownloadDirectory(`[Settings]\r\n${onDisk}\r\n`)).toBe(String.raw`Z:\home\x`);
  });

  it('reads a plain value needing no escaping (a POSIX path) unchanged', () => {
    expect(readDownloadDirectory('[Settings]\r\ndownload_directory=/mnt/storage/downloads\r\n'))
      .toBe('/mnt/storage/downloads');
  });

  it('strips the quote wrapper and un-escapes a value Qt quoted for a special character', () => {
    const onDisk = String.raw`download_directory="C:\\Games;New"`; // `;` forces Qt's quote wrap
    expect(readDownloadDirectory(`[Settings]\r\n${onDisk}\r\n`)).toBe(String.raw`C:\Games;New`);
  });

  it('unwraps an @ByteArray(...) value with no unescaping, matching gamePath\'s own raw bytes', () => {
    expect(readDownloadDirectory('[Settings]\r\ndownload_directory=@ByteArray(%BASE_DIR%/downloads)\r\n'))
      .toBe('%BASE_DIR%/downloads');
  });

  // MO2's own settings dialog removes the key rather than write it empty (setConfigurablePath);
  // a present-but-empty value is read the same way, as unset, not as an empty path.
  it('reads an empty value as unset, as MO2\'s own default-path behaviour does', () => {
    expect(readDownloadDirectory('[Settings]\r\ndownload_directory=\r\n')).toBeUndefined();
  });
});

describe('setSelectedProfileInText — surgical, byte-faithful', () => {
  it('rewrites only the selected_profile value, preserving every other byte', () => {
    const input = ini();
    const out = setSelectedProfileInText(input, 'Secondary');
    expect(out).toBe(input.replace('@ByteArray(Default)', '@ByteArray(Secondary)'));
    expect(readSelectedProfile(out)).toBe('Secondary');
    expect(out).toContain('[Settings]\r\nlanguage=en\r\n'); // other section untouched
    expect(out).toContain('gamePath=@ByteArray('); // gamePath untouched
  });

  it('is a no-op (identical bytes) when setting the current profile', () => {
    expect(setSelectedProfileInText(ini(), 'Default')).toBe(ini());
  });

  it('throws a message naming the missing key when selected_profile is absent', () => {
    expect(() => setSelectedProfileInText('[General]\r\ngameName=Fallout 4\r\n', 'X')).toThrow(
      /missing selected_profile/,
    );
  });
});
